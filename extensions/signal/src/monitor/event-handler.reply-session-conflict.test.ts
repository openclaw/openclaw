// Signal tests cover durable redelivery after dispatch failures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSignalIngressMonitor } from "../signal-ingress.js";

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

const {
  sendTypingMock,
  sendReadReceiptMock,
  sendReactionSignalMock,
  removeReactionSignalMock,
  dispatchInboundMessageMock,
  recordInboundSessionMock,
} = vi.hoisted(() => ({
  sendTypingMock: vi.fn(),
  sendReadReceiptMock: vi.fn(),
  sendReactionSignalMock: vi.fn(async () => ({ ok: true })),
  removeReactionSignalMock: vi.fn(async () => ({ ok: true })),
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: sendReactionSignalMock,
  removeReactionSignal: removeReactionSignalMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  const { createSignalPreparedDispatchRunner } = await import("./event-handler.test-harness.js");
  return {
    ...actual,
    // Retry timing must not depend on filesystem or worker scheduling.
    resolveInboundSessionEnvelopeContextAsync: vi
      .fn<typeof actual.resolveInboundSessionEnvelopeContextAsync>()
      .mockImplementation(async ({ cfg }) => ({
        storePath: "/tmp/openclaw/signal-sessions.json",
        envelopeOptions: actual.resolveEnvelopeFormatOptions(cfg),
        previousTimestamp: undefined,
      })),
    runChannelInboundEvent: createSignalPreparedDispatchRunner(
      actual.runChannelInboundEvent,
      recordInboundSessionMock,
      async (resolved) => await dispatchInboundMessageMock({ ctx: resolved.ctxPayload }),
    ),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    recordInboundSession: recordInboundSessionMock,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
});

const CONFLICT_ERROR = new Error(
  "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
);

function createTrackedTaskHarness() {
  const tasks: Promise<void>[] = [];
  return {
    tasks,
    runTrackedTask: (task: () => Promise<void>) => {
      tasks.push(task());
    },
  };
}

describe("signal durable dispatch failure recovery", () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    sendReactionSignalMock.mockReset().mockResolvedValue({ ok: true });
    removeReactionSignalMock.mockReset().mockResolvedValue({ ok: true });
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    dispatchInboundMessageMock.mockReset();
  });

  it("preserves durable abandon accounting through backoff, threshold, and restart", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "signal",
      accountId: "default",
      stateDir,
      now: () => Date.now(),
    });
    const timestamp = 1_700_000_000_777;
    const event = createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message: "retry through durable ingress", attachments: [] },
    });
    const eventId = JSON.stringify(["number:+15550001111", timestamp]);
    dispatchInboundMessageMock.mockRejectedValue(CONFLICT_ERROR);

    const createIntegratedMonitor = async () => {
      const tracked = createTrackedTaskHarness();
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: { messages: { inbound: { debounceMs: 10 } } },
          runTrackedTask: tracked.runTrackedTask,
        }),
      );
      const dispatched = createDeferred<Awaited<ReturnType<typeof handler>>>();
      const monitor = await startSignalIngressMonitor({
        accountId: "default",
        queue,
        dispatch: (incoming, lifecycle) => {
          const handling = handler(incoming, lifecycle);
          dispatched.resolve(handling);
          return handling;
        },
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      return { monitor, tracked, dispatched };
    };
    const finishOuterAttempt = async ({
      tracked,
      dispatched,
    }: Awaited<ReturnType<typeof createIntegratedMonitor>>) => {
      await dispatched.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(tracked.tasks).toHaveLength(1);
      await Promise.all(tracked.tasks);
    };
    const pendingAttempt = async (attempts: number) => {
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toEqual([
        expect.objectContaining({
          id: eventId,
          attempts,
          lastAttemptAt: expect.any(Number),
          lastError: CONFLICT_ERROR.message,
        }),
      ]);
      const record = pending[0];
      const lastAttemptAt = record?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Signal retry timestamp for attempt ${attempts}`);
      }
      return { ...record, lastAttemptAt };
    };

    try {
      const first = await createIntegratedMonitor();
      await first.monitor.receive(event);
      await finishOuterAttempt(first);
      const firstAttempt = await pendingAttempt(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      await first.monitor.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
      const blocked = await createIntegratedMonitor();
      await blocked.monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(blocked.tracked.tasks).toHaveLength(0);
      await blocked.monitor.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
      const second = await createIntegratedMonitor();
      await finishOuterAttempt(second);
      const secondAttempt = await pendingAttempt(2);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      await second.monitor.stop();

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim(eventId, { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Signal seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: CONFLICT_ERROR.message,
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }

      vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
      const threshold = await createIntegratedMonitor();
      await finishOuterAttempt(threshold);
      const thresholdAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);
      await threshold.monitor.stop();

      vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
      const beyond = await createIntegratedMonitor();
      await finishOuterAttempt(beyond);
      const beyondAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);
      await beyond.monitor.stop();

      vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
      const blockedRestart = await createIntegratedMonitor();
      await blockedRestart.monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);
      expect(blockedRestart.tracked.tasks).toHaveLength(0);
      await blockedRestart.monitor.stop();
    } finally {
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not retry non-conflict flush failures", async () => {
    dispatchInboundMessageMock.mockRejectedValue(new Error("some other dispatch failure"));

    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());

    vi.useFakeTimers();
    try {
      await handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello",
            attachments: [],
          },
        }),
      );

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
