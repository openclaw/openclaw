import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  readQueuedDeliveryEntriesForTest,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSignalApprovalReactionTargetWithPersistence } from "../approval-reactions.js";
import type { SignalIngressMonitor } from "../signal-ingress.js";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

const reactionStores = await vi.hoisted(() => import("../approval-reactions.test-support.js"));
const { fixture, getReplyFromConfigMock, sendMessageSignalMock } = vi.hoisted(() => ({
  fixture: { prepared: false, record: vi.fn(async () => {}) },
  getReplyFromConfigMock: vi.fn(),
  sendMessageSignalMock: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  const { signalInboundTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  const prepared = await signalInboundTestModule(
    actual,
    fixture.record,
    async (resolved) => await getReplyFromConfigMock({ ctx: resolved.ctxPayload }),
  );
  return {
    ...actual,
    resolveInboundSessionEnvelopeContextAsync: (
      ...args: Parameters<typeof actual.resolveInboundSessionEnvelopeContextAsync>
    ) => (fixture.prepared ? prepared : actual).resolveInboundSessionEnvelopeContextAsync(...args),
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      if (fixture.prepared) {
        return await prepared.runChannelInboundEvent(params);
      }
      const resolveTurn = params.adapter.resolveTurn;
      return await actual.runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (...args: Parameters<typeof resolveTurn>) => {
            const resolved = await resolveTurn(...args);
            return "runDispatch" in resolved
              ? resolved
              : ({ ...resolved, replyResolver: getReplyFromConfigMock } as typeof resolved);
          },
        },
      });
    },
  };
});
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  const { signalConversationTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  const prepared = signalConversationTestModule(actual, fixture.record);
  return {
    ...actual,
    readChannelAllowFromStore: (...args: Parameters<typeof actual.readChannelAllowFromStore>) =>
      (fixture.prepared ? prepared : actual).readChannelAllowFromStore(...args),
    upsertChannelPairingRequest: (...args: Parameters<typeof actual.upsertChannelPairingRequest>) =>
      (fixture.prepared ? prepared : actual).upsertChannelPairingRequest(...args),
  };
});
vi.mock("../send.js", () => ({
  sendMessageSignal: sendMessageSignalMock,
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
}));
vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

// Reload the same runtime graph for the process-restart case; retain the durable queue.
async function loadRuntime() {
  const [channel, handler, harness, ingress, plugins, replies] = await Promise.all([
    import("../channel.js"),
    import("./event-handler.js"),
    import("./event-handler.test-harness.js"),
    import("../signal-ingress.js"),
    import("openclaw/plugin-sdk/plugin-test-runtime"),
    import("openclaw/plugin-sdk/reply-runtime"),
  ]);
  return { channel, handler, harness, ingress, plugins, replies };
}
let runtime = await loadRuntime();
const { deliverReplies } = await import("../monitor.js");
type Queue = NonNullable<Parameters<typeof runtime.ingress.startSignalIngressMonitor>[0]["queue"]>;

describe("Signal durable ingress and final delivery", () => {
  let state: OpenClawTestState;
  let queue: Queue;
  let cfg: OpenClawConfig;
  let monitor: SignalIngressMonitor | undefined;
  const eventAt = (timestamp: number, message: string) =>
    runtime.harness.createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message, attachments: [] },
    });
  const sentTexts = () => sendMessageSignalMock.mock.calls.map(([, text]) => text);
  const deliveries = () => readQueuedDeliveryEntriesForTest(state.stateDir);
  function registerPlugin(durableText = true) {
    const plugin = runtime.channel.signalPlugin;
    const registered = durableText
      ? plugin
      : {
          ...plugin,
          message: { ...plugin.message!, durableFinal: { capabilities: { text: false } } },
        };
    runtime.plugins.setActivePluginRegistry(
      runtime.plugins.createTestRegistry([
        { pluginId: "signal", source: "test", plugin: registered },
      ]),
    );
  }
  const createHandler = (overrides: Partial<SignalEventHandlerDeps> = {}) =>
    runtime.handler.createSignalEventHandler(
      runtime.harness.createBaseSignalEventHandlerDeps({
        cfg,
        deliverReplies: async (params) =>
          await deliverReplies({ ...params, cfg, chunkMode: "length" }),
        ...overrides,
      }),
    );
  const stop = async () => {
    await monitor?.stop();
    monitor = undefined;
  };
  const start = async (handler = createHandler()) => {
    await stop();
    monitor = await runtime.ingress.startSignalIngressMonitor({
      accountId: "default",
      queue,
      dispatch: handler,
      runtime: { error: vi.fn(), log: vi.fn() },
    });
  };
  const receive = async (event: ReturnType<typeof eventAt>) => {
    if (!monitor) {
      throw new Error("Signal test monitor is not running");
    }
    await monitor.receive(event);
    await monitor.waitForIdle();
  };
  beforeEach(async () => {
    fixture.prepared = false;
    fixture.record.mockReset().mockResolvedValue(undefined);
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-signal-partial-delivery-",
    });
    queue = createChannelIngressQueueForTests({
      channelId: "signal",
      accountId: "default",
      stateDir: state.stateDir,
      now: () => Date.now(),
    });
    cfg = {
      session: { store: state.statePath("sessions") },
      channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    registerPlugin();
    reactionStores.clearSignalApprovalReactionStoresForTest();
    getReplyFromConfigMock.mockReset();
    sendMessageSignalMock.mockReset();
  });
  afterEach(async () => {
    await stop();
    vi.useRealTimers();
    runtime.plugins.resetPluginRuntimeStateForTest();
    resetPluginRuntimeStateForTest();
    reactionStores.clearSignalApprovalReactionStoresForTest();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("tombstones an accepted approval prefix and retains its reaction binding", async () => {
    cfg.channels = {
      signal: {
        account: "+15550009999",
        dmPolicy: "allowlist",
        allowFrom: ["+15550001111"],
        textChunkLimit: 4_000,
      },
    };
    cfg.approvals = {
      exec: {
        enabled: true,
        mode: "targets",
        targets: [{ channel: "signal", to: "+15550001111" }],
      },
    };
    getReplyFromConfigMock.mockResolvedValue({
      ...buildExecApprovalPendingReplyPayload({
        approvalId: "exec-partial",
        approvalSlug: "exec-partial",
        allowedDecisions: ["allow-once", "deny"],
        command: "printf test",
        host: "gateway",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15550001111",
      }),
      mediaUrls: ["https://example.test/one.png", "https://example.test/two.png"],
    });
    sendMessageSignalMock
      .mockResolvedValueOnce({ messageId: "1700000005999" })
      .mockRejectedValueOnce(new Error("second Signal send failed"));
    await start(createHandler({ account: "+15550009999" }));
    const event = eventAt(1_700_000_005_001, "please run it");
    await receive(event);
    expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    expect(sentTexts()[0]).toContain("React with:");
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15550001111",
        messageId: "1700000005999",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toMatchObject({ approvalId: "exec-partial", decision: "allow-once" });
    await receive(event);
    expect(getReplyFromConfigMock).toHaveBeenCalledOnce();
    expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [true, false, 1_700_000_005_004],
    [true, true, 1_700_000_005_005],
    [false, false, 1_700_000_005_003],
  ] as const)(
    "recovers final delivery (durable=%s, prior block=%s)",
    async (durable, sendBlock, timestamp) => {
      registerPlugin(durable);
      const text = "Distinct final";
      getReplyFromConfigMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
        if (sendBlock) {
          await options.onBlockReply?.({ text: "Delivered block" });
        }
        return { text };
      });
      if (sendBlock) {
        sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006002" });
      }
      sendMessageSignalMock.mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("Signal offline before final dispatch", {
          cause: new Error("offline"),
        }),
      );
      const handler = createHandler(durable ? { blockStreaming: true } : {});
      const event = eventAt(timestamp, "send a block and a final");
      const initialTexts = [...(sendBlock ? ["Delivered block"] : []), text];
      await start(handler);
      await receive(event);
      await stop();
      expect(sentTexts()).toEqual(initialTexts);
      if (durable) {
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(deliveries()).toHaveLength(1);
        expect(deliveries()[0]?.lastError).toContain("Signal offline before final dispatch");
        await start(handler);
        await receive(event);
        expect(getReplyFromConfigMock).toHaveBeenCalledOnce();
        expect(sentTexts()).toEqual(initialTexts);
        sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006003" });
        const drain = () =>
          drainPendingDeliveries({
            cfg,
            stateDir: state.stateDir,
            drainKey: "signal:test-recovery",
            logLabel: "Signal recovery",
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            selectEntry: (entry) => ({ match: entry.channel === "signal", bypassBackoff: true }),
          });
        await drain();
        expect(sentTexts()).toEqual([...initialTexts, text]);
        expect(deliveries()).toEqual([]);
        await drain();
        await receive(event);
        expect(getReplyFromConfigMock).toHaveBeenCalledOnce();
      } else {
        expect(deliveries()).toEqual([]);
        const [pending] = await queue.listPending({ limit: "all" });
        expect(pending).toMatchObject({
          attempts: 1,
          lastError: expect.stringContaining("Signal offline before final dispatch"),
        });
        if (!pending) {
          throw new Error("expected retryable Signal ingress row");
        }
        await queue.release(pending.id, {
          ...(pending.lastError ? { lastError: pending.lastError } : {}),
          releasedAt: 1,
        });
        sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006001" });
        vi.resetModules();
        runtime = await loadRuntime();
        runtime.replies.resetInboundDedupe();
        registerPlugin(false);
        await start();
        await receive(event);
        expect(getReplyFromConfigMock).toHaveBeenCalledTimes(2);
        expect(sentTexts()).toEqual([...initialTexts, text]);
        expect(deliveries()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        await expect(
          queue.enqueue(pending.id, pending.payload, {
            receivedAt: pending.receivedAt,
            laneKey: pending.laneKey,
          }),
        ).resolves.toMatchObject({ kind: "completed", duplicate: true });
        await receive(event);
      }
      expect(sentTexts()).toEqual([...initialTexts, text]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
    },
  );

  it("preserves durable abandon accounting through backoff, threshold, and restart", async () => {
    fixture.prepared = true;
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    cfg = { messages: { inbound: { debounceMs: 10 } } };
    const error = new Error(
      "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
    );
    getReplyFromConfigMock.mockRejectedValue(error);
    const timestamp = 1_700_000_000_777;
    const event = eventAt(timestamp, "retry through durable ingress");
    const eventId = JSON.stringify(["number:+15550001111", timestamp]);
    const createIntegratedMonitor = async () => {
      const tasks: Promise<void>[] = [];
      const handler = createHandler({
        runTrackedTask: (task) => {
          tasks.push(task());
        },
      });
      const dispatched = createDeferred<Awaited<ReturnType<typeof handler>>>();
      await start((incoming, lifecycle) => {
        const handling = handler(incoming, lifecycle);
        dispatched.resolve(handling);
        return handling;
      });
      return { tasks, dispatched };
    };
    const retryAt = async (time: number, attempts: number, dispatches: number, initial = false) => {
      vi.setSystemTime(time);
      const { tasks, dispatched } = await createIntegratedMonitor();
      if (initial) {
        await monitor?.receive(event);
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
          lastError: error.message,
        }),
      ]);
      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(dispatches);
      await stop();
      return pending[0]!.lastAttemptAt!;
    };
    const blockedAt = async (time: number, dispatches: number) => {
      vi.setSystemTime(time);
      const { tasks } = await createIntegratedMonitor();
      await monitor?.waitForIdle();
      await vi.advanceTimersByTimeAsync(10);
      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(dispatches);
      expect(tasks).toHaveLength(0);
      await stop();
    };
    const firstAttemptAt = await retryAt(now, 1, 1, true);
    await blockedAt(firstAttemptAt + 999, 1);
    const secondAttemptAt = await retryAt(firstAttemptAt + 1_001, 2, 2);
    for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const claim = await queue.claim(eventId, { ownerId: `seed-${attempt}` });
      if (!claim) {
        throw new Error("expected Signal seed claim");
      }
      await queue.release(claim, { lastError: error.message, releasedAt: secondAttemptAt });
    }
    const threshold = DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS;
    const thresholdAttemptAt = await retryAt(secondAttemptAt + 64_001, threshold, 3);
    const beyondAttemptAt = await retryAt(thresholdAttemptAt + 128_001, threshold + 1, 4);
    await blockedAt(beyondAttemptAt + 1_000, 4);
  });
});
