import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSignalIngressMonitor } from "../signal-ingress.js";

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

const { dispatchInboundMessageMock, recordInboundSessionMock } = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
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

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
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

describe("signal durable dispatch failure recovery", () => {
  beforeEach(() => {
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    dispatchInboundMessageMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

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
      const tasks: Promise<void>[] = [];
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: { messages: { inbound: { debounceMs: 10 } } },
          runTrackedTask: (task) => {
            tasks.push(task());
          },
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
      return { monitor, tasks, dispatched };
    };
    const retryAt = async (time: number, attempts: number, dispatches: number, initial = false) => {
      vi.setSystemTime(time);
      const { monitor, tasks, dispatched } = await createIntegratedMonitor();
      if (initial) {
        await monitor.receive(event);
      }
      await dispatched.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toEqual([
        expect.objectContaining({
          id: eventId,
          attempts,
          lastAttemptAt: expect.any(Number),
          lastError: CONFLICT_ERROR.message,
        }),
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatches);
      await monitor.stop();
      return expectDefined(pending[0]?.lastAttemptAt, "Signal retry timestamp");
    };
    const blockedAt = async (time: number, dispatches: number) => {
      vi.setSystemTime(time);
      const blocked = await createIntegratedMonitor();
      await blocked.monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatches);
      expect(blocked.tasks).toHaveLength(0);
      await blocked.monitor.stop();
    };

    try {
      const firstAttemptAt = await retryAt(now, 1, 1, true);

      await blockedAt(firstAttemptAt + 999, 1);
      const secondAttemptAt = await retryAt(firstAttemptAt + 1_001, 2, 2);

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = expectDefined(
          await queue.claim(eventId, { ownerId: `seed-${attempt}` }),
          "Signal seed claim",
        );
        await queue.release(claim, {
          lastError: CONFLICT_ERROR.message,
          releasedAt: secondAttemptAt,
        });
      }

      const threshold = DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS;
      const thresholdAttemptAt = await retryAt(secondAttemptAt + 64_001, threshold, 3);
      const beyondAttemptAt = await retryAt(thresholdAttemptAt + 128_001, threshold + 1, 4);
      await blockedAt(beyondAttemptAt + 1_000, 4);
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
    await handler(createSignalReceiveEvent({ dataMessage: { message: "hello", attachments: [] } }));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });
});
