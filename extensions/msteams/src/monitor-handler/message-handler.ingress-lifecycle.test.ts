import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createMSTeamsIngress } from "../msteams-ingress.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function createLifecycle(): MSTeamsIngressLifecycle & {
  onAdopted: ReturnType<typeof vi.fn>;
  onAbandoned: ReturnType<typeof vi.fn>;
} {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
  };
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function directActivity(id: string, text: string): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id,
      text,
      conversation: { id: "dm-conversation", conversationType: "personal" },
      channelData: {},
      entities: [],
    }),
  } as MSTeamsTurnContext["activity"];
}

function createHandler(cfg: OpenClawConfig, createDebouncer = createInboundDebouncer) {
  const { deps } = createMessageHandlerDeps(cfg, {
    createInboundDebouncer: createDebouncer,
    resolveInboundDebounceMs: vi.fn(() => 40),
  });
  return createMSTeamsMessageHandler(deps);
}

describe("Microsoft Teams drain claim ownership", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("fans merged-flush adoption to every constituent claim", async () => {
    const handler = createHandler({
      messages: { inbound: { debounceMs: 40 } },
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig);
    const first = createLifecycle();
    const second = createLifecycle();

    const results = [
      await handler(context(directActivity("activity-first", "part one")), first),
      await handler(context(directActivity("activity-second", "part two")), second),
    ];

    expect(results).toEqual([{ kind: "deferred" }, { kind: "deferred" }]);
    await vi.waitFor(
      () => {
        expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
          1,
        );
        expect(first.onAdopted).toHaveBeenCalledTimes(1);
        expect(second.onAdopted).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000 },
    );
    const dispatchParams = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock
      .calls[0]?.[0] as { ctx?: { BodyForAgent?: string } } | undefined;
    expect(dispatchParams?.ctx?.BodyForAgent).toContain("part one\npart two");
    expect(first.onAbandoned).not.toHaveBeenCalled();
    expect(second.onAbandoned).not.toHaveBeenCalled();
  });

  it("dispatches HTML-only text through the immediate debounce flush without double stripping", async () => {
    const handler = createHandler({
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    const lifecycle = createLifecycle();

    await handler(
      context({
        ...directActivity("activity-html", ""),
        attachments: [
          {
            contentType: "TEXT/HTML",
            content: "<at>Bot</at><p>Use x &lt; 5 &copy;; literal &lt;at&gt;Alice&lt;/at&gt;</p>",
          },
        ],
      }),
      lifecycle,
    );

    expect(
      runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: expect.stringContaining("Use x < 5 ©; literal <at>Alice</at>"),
        }),
      }),
    );
    expect(
      runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].replyOptions
        ?.turnAdoptionLifecycle,
    ).toMatchObject({ admission: "exclusive" });
    expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("completes a gated no-dispatch turn instead of stalling its claim", async () => {
    const { deps } = createMessageHandlerDeps(
      {
        channels: {
          msteams: {
            groupPolicy: "open",
            requireMention: true,
          },
        },
      } as OpenClawConfig,
      {
        createInboundDebouncer,
        resolveInboundDebounceMs: vi.fn(() => 20),
      },
    );
    const handler = createMSTeamsMessageHandler(deps);
    const lifecycle = createLifecycle();
    const gatedActivity = buildChannelActivity({
      id: "activity-gated",
      text: "not for the bot",
      entities: [],
    }) as MSTeamsTurnContext["activity"];

    const result = await handler(context(gatedActivity), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "msteams",
      accountId: "test-app",
      stateDir,
    });
    const incoming = directActivity("activity-abandon", "retry me");
    await queue.enqueue(
      "activity-abandon",
      { version: 1, receivedAt: now - 2 * 24 * 60 * 60_000, rawActivity: JSON.stringify(incoming) },
      { laneKey: "dm-conversation", receivedAt: now - 2 * 24 * 60 * 60_000 },
    );
    const dispatchMock = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    const priorImplementation = dispatchMock.getMockImplementation();
    dispatchMock.mockRejectedValue(new Error("Microsoft Teams dispatch failed before adoption"));

    let stopCurrent: (() => Promise<void>) | undefined;
    const createIntegratedIngress = () => {
      let capturedDrain: (() => Promise<void>) | undefined;
      const createDebouncer: typeof createInboundDebouncer = (options) => {
        const debouncer = createInboundDebouncer(options);
        capturedDrain = debouncer.drain;
        return debouncer;
      };
      const handler = createHandler(
        { channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } } },
        createDebouncer,
      );
      const ingress = createMSTeamsIngress({
        accountId: "test-app",
        queue,
        runtime: { error: vi.fn(), log: vi.fn() },
        dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
      });
      const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
      if (monitorResult?.type !== "return" || !capturedDrain) {
        throw new Error("Expected the Microsoft Teams ingress and debounce owners");
      }
      const monitor = monitorResult.value;
      const drainDebounce = capturedDrain;
      stopCurrent = async () => {
        await monitor.pause();
        await monitor.waitForIdle();
        await vi.advanceTimersByTimeAsync(40);
        await drainDebounce();
        await ingress.stop();
      };
      return { ...ingress, waitForIdle: monitor.waitForIdle, drainDebounce };
    };
    const expectPendingAttempt = async (
      ingress: ReturnType<typeof createIntegratedIngress>,
      attempts: number,
    ) => {
      await ingress.waitForIdle();
      await vi.advanceTimersByTimeAsync(40);
      await ingress.drainDebounce();
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toEqual([
        expect.objectContaining({
          id: "activity-abandon",
          attempts,
          lastAttemptAt: expect.any(Number),
          lastError: "turn-abandoned",
        }),
      ]);
      const observed = pending[0];
      const lastAttemptAt = observed?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Microsoft Teams retry timestamp for attempt ${attempts}`);
      }
      return { ...observed, lastAttemptAt };
    };

    try {
      const first = createIntegratedIngress();
      first.start();
      const firstAttempt = await expectPendingAttempt(first, 1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      await first.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
      const second = createIntegratedIngress();
      second.start();
      await second.accept(incoming);
      await second.waitForIdle();
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(await queue.listPending({ limit: "all" })).toEqual([firstAttempt]);
      await second.stop();
      vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
      const afterBackoff = createIntegratedIngress();
      afterBackoff.start();
      await afterBackoff.accept(incoming);
      const secondAttempt = await expectPendingAttempt(afterBackoff, 2);
      expect(dispatchMock).toHaveBeenCalledTimes(2);
      await afterBackoff.stop();

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("activity-abandon", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Microsoft Teams seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }
      vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
      const threshold = createIntegratedIngress();
      threshold.start();
      await threshold.accept(incoming);
      const thresholdAttempt = await expectPendingAttempt(
        threshold,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      );
      expect(dispatchMock).toHaveBeenCalledTimes(3);
      await threshold.stop();

      vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
      const beyond = createIntegratedIngress();
      beyond.start();
      await beyond.accept(incoming);
      const beyondAttempt = await expectPendingAttempt(
        beyond,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1,
      );
      expect(dispatchMock).toHaveBeenCalledTimes(4);
      await beyond.stop();

      vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
      const blockedRestart = createIntegratedIngress();
      blockedRestart.start();
      await blockedRestart.accept(incoming);
      await blockedRestart.waitForIdle();
      expect(dispatchMock).toHaveBeenCalledTimes(4);
      expect(await queue.listPending({ limit: "all" })).toEqual([beyondAttempt]);
      await blockedRestart.stop();
    } finally {
      try {
        await stopCurrent?.();
      } finally {
        vi.useRealTimers();
        dispatchMock.mockReset();
        if (priorImplementation) {
          dispatchMock.mockImplementation(priorImplementation);
        }
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    }
  });
});
