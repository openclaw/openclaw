// Signal integration coverage for durable ingress after a partially visible final reply.
import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  createTestRegistry,
  readQueuedDeliveryEntriesForTest,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "../approval-reactions.js";
import { signalPlugin } from "../channel.js";
import type { SignalIngressLifecycle } from "../signal-ingress.js";

const { getReplyFromConfigMock, sendMessageSignalMock } = vi.hoisted(() => ({
  getReplyFromConfigMock: vi.fn(),
  sendMessageSignalMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
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

vi.mock("../send.js", () => ({
  sendMessageSignal: sendMessageSignalMock,
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

const [{ deliverReplies }, { startSignalIngressMonitor }, eventHandlerModule, harnessModule] =
  await Promise.all([
    import("../monitor.js"),
    import("../signal-ingress.js"),
    import("./event-handler.js"),
    import("./event-handler.test-harness.js"),
  ]);

type SignalIngressQueue = ReturnType<typeof createChannelIngressQueueForTests<unknown>>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];

describe("Signal partial final delivery ingress boundary", () => {
  let state: OpenClawTestState;
  let queue: ReturnType<typeof createChannelIngressQueueForTests<SignalIngressPayload>>;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-signal-partial-delivery-",
    });
    queue = createChannelIngressQueueForTests({
      channelId: "signal",
      accountId: "default",
      stateDir: state.stateDir,
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", plugin: signalPlugin, source: "test" }]),
    );
    clearSignalApprovalReactionTargetsForTest();
    getReplyFromConfigMock.mockReset();
    sendMessageSignalMock.mockReset();
  });

  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    clearSignalApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("tombstones an accepted approval prefix and retains its reaction binding", async () => {
    const afterDeliverPayload = vi.spyOn(signalPlugin.outbound!, "afterDeliverPayload");
    const timestamp = 1_700_000_005_001;
    const cfg = {
      session: { store: state.statePath("sessions") },
      channels: {
        signal: {
          account: "+15550009999",
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          textChunkLimit: 4_000,
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15550001111" }],
        },
      },
    } as OpenClawConfig;
    const payload = {
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
    };
    getReplyFromConfigMock.mockResolvedValue(payload);
    sendMessageSignalMock
      .mockResolvedValueOnce({ messageId: "1700000005999" })
      .mockRejectedValueOnce(new Error("second Signal send failed"));

    const handler = eventHandlerModule.createSignalEventHandler(
      harnessModule.createBaseSignalEventHandlerDeps({
        cfg,
        baseUrl: "http://signal.test:8080",
        account: "+15550009999",
        accountId: "default",
        mediaMaxBytes: 8 * 1024 * 1024,
        deliverReplies: async (params) =>
          await deliverReplies({ ...params, cfg, chunkMode: "length" }),
      }),
    );
    const monitor = await startSignalIngressMonitor({
      accountId: "default",
      queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
      dispatch: async (event, lifecycle: SignalIngressLifecycle) => await handler(event, lifecycle),
      runtime: { error: vi.fn(), log: vi.fn() },
    });
    const event = harnessModule.createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message: "please run it", attachments: [] },
    });

    try {
      await monitor.receive(event);
      await monitor.waitForIdle();

      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
      expect(sendMessageSignalMock.mock.calls[0]?.[1]).toContain("React with:");
      expect(afterDeliverPayload).toHaveBeenCalledOnce();
      expect(afterDeliverPayload.mock.calls[0]?.[0]).toMatchObject({
        payload: { text: expect.stringContaining("React with:") },
        results: [{ messageId: "1700000005999" }],
      });
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await expect(
        resolveSignalApprovalReactionTargetWithPersistence({
          accountId: "default",
          conversationKey: "+15550001111",
          messageId: "1700000005999",
          reactionKey: "👍",
          targetAuthor: "+15550009999",
        }),
      ).resolves.toMatchObject({
        approvalId: "exec-partial",
        decision: "allow-once",
      });

      await monitor.receive(event);
      await monitor.waitForIdle();
      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    } finally {
      await monitor.stop();
    }
  });

  it.each([false, true])(
    "recovers an unsent final without replaying ingress (successful block: %s)",
    async (sendBlock) => {
      const timestamp = sendBlock ? 1_700_000_005_005 : 1_700_000_005_004;
      const cfg = {
        session: { store: state.statePath("sessions") },
        channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
      } as OpenClawConfig;
      getReplyFromConfigMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
        if (sendBlock) {
          await options.onBlockReply?.({ text: "Delivered block" });
        }
        return { text: "Distinct final" };
      });
      if (sendBlock) {
        sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006002" });
      }
      sendMessageSignalMock.mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("Signal offline before final dispatch", {
          cause: new Error("offline"),
        }),
      );
      const handler = eventHandlerModule.createSignalEventHandler(
        harnessModule.createBaseSignalEventHandlerDeps({
          cfg,
          blockStreaming: true,
          deliverReplies: async (params) =>
            await deliverReplies({ ...params, cfg, chunkMode: "length" }),
        }),
      );
      const createMonitor = async () =>
        await startSignalIngressMonitor({
          accountId: "default",
          queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
          dispatch: async (event, lifecycle) => await handler(event, lifecycle),
          runtime: { error: vi.fn(), log: vi.fn() },
        });
      const event = harnessModule.createSignalReceiveEvent({
        timestamp,
        dataMessage: { timestamp, message: "send a block and a final", attachments: [] },
      });
      const monitor = await createMonitor();
      const initialTexts = [...(sendBlock ? ["Delivered block"] : []), "Distinct final"];
      try {
        await monitor.receive(event);
        await monitor.waitForIdle();
        expect(sendMessageSignalMock.mock.calls.map(([, text]) => text)).toEqual(initialTexts);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toMatchObject([
          {
            channel: "signal",
            preparedBatch: {
              sourcePayloadCount: 1,
              entries: [{ status: "accepted", payload: { text: "Distinct final" } }],
            },
            lastError: expect.stringContaining("Signal offline before final dispatch"),
          },
        ]);
      } finally {
        await monitor.stop();
      }

      const restarted = await createMonitor();
      try {
        await restarted.receive(event);
        await restarted.waitForIdle();
        expect(getReplyFromConfigMock).toHaveBeenCalledOnce();
        expect(sendMessageSignalMock).toHaveBeenCalledTimes(initialTexts.length);
        expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toHaveLength(1);
        sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006003" });
        const drain = async () =>
          await drainPendingDeliveries({
            cfg,
            stateDir: state.stateDir,
            drainKey: "signal:test-recovery",
            logLabel: "Signal recovery",
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            selectEntry: (entry) => ({ match: entry.channel === "signal", bypassBackoff: true }),
          });
        await drain();
        expect(sendMessageSignalMock.mock.calls.map(([, text]) => text)).toEqual([
          ...initialTexts,
          "Distinct final",
        ]);
        expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toEqual([]);

        await drain();
        await restarted.receive(event);
        await restarted.waitForIdle();
        expect(getReplyFromConfigMock).toHaveBeenCalledOnce();
        expect(sendMessageSignalMock).toHaveBeenCalledTimes(initialTexts.length + 1);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        await restarted.stop();
      }
    },
  );

  it("retries an unqueued final after a fresh monitor restart when durable text is unsupported", async () => {
    const timestamp = 1_700_000_005_003;
    const error = new PlatformMessageNotDispatchedError("Signal offline before dispatch", {
      cause: new Error("offline"),
    });
    getReplyFromConfigMock.mockResolvedValue({ text: "retry me" });
    sendMessageSignalMock.mockRejectedValueOnce(error);
    const cfg = {
      session: { store: state.statePath("sessions") },
      channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "signal",
          plugin: {
            ...signalPlugin,
            message: {
              ...signalPlugin.message!,
              durableFinal: { capabilities: { text: false } },
            },
          },
          source: "test-direct-delivery",
        },
      ]),
    );
    const createMonitor = async () => {
      const handler = eventHandlerModule.createSignalEventHandler(
        harnessModule.createBaseSignalEventHandlerDeps({
          cfg,
          deliverReplies: async (params) =>
            await deliverReplies({ ...params, cfg, chunkMode: "length" }),
        }),
      );
      return await startSignalIngressMonitor({
        accountId: "default",
        queue: queue as Parameters<typeof startSignalIngressMonitor>[0]["queue"],
        dispatch: async (event, lifecycle) => await handler(event, lifecycle),
        runtime: { error: vi.fn(), log: vi.fn() },
      });
    };
    const event = harnessModule.createSignalReceiveEvent({
      timestamp,
      dataMessage: { timestamp, message: "please retry", attachments: [] },
    });

    const first = await createMonitor();
    await first.receive(event);
    await first.waitForIdle();
    await first.stop();
    expect(sendMessageSignalMock.mock.calls.map(([, text]) => text)).toEqual(["retry me"]);
    expect(sendMessageSignalMock).toHaveBeenCalledOnce();
    expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toEqual([]);
    const [pending] = await queue.listPending({ limit: "all" });
    expect(pending).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("Signal offline before dispatch"),
    });
    if (!pending) {
      throw new Error("expected retryable Signal ingress row");
    }

    // Advance the durable retry clock through its owner API, then rebuild the process-local
    // runtime graph while retaining the same SQLite queue to model a real monitor restart.
    await queue.release(pending.id, {
      ...(pending.lastError ? { lastError: pending.lastError } : {}),
      releasedAt: 1,
    });
    sendMessageSignalMock.mockResolvedValueOnce({ messageId: "1700000006001" });
    vi.resetModules();
    const [
      freshChannel,
      freshHandlerModule,
      freshHarness,
      freshIngress,
      freshPluginRuntime,
      freshReplyRuntime,
    ] = await Promise.all([
      import("../channel.js"),
      import("./event-handler.js"),
      import("./event-handler.test-harness.js"),
      import("../signal-ingress.js"),
      import("openclaw/plugin-sdk/plugin-test-runtime"),
      import("openclaw/plugin-sdk/reply-runtime"),
    ]);
    freshReplyRuntime.resetInboundDedupe();
    freshPluginRuntime.setActivePluginRegistry(
      freshPluginRuntime.createTestRegistry([
        {
          pluginId: "signal",
          plugin: {
            ...freshChannel.signalPlugin,
            message: {
              ...freshChannel.signalPlugin.message!,
              durableFinal: { capabilities: { text: false } },
            },
          },
          source: "test-restart",
        },
      ]),
    );
    const retryHandler = freshHandlerModule.createSignalEventHandler(
      freshHarness.createBaseSignalEventHandlerDeps({
        cfg,
        deliverReplies: async (params) =>
          await deliverReplies({ ...params, cfg, chunkMode: "length" }),
      }),
    );
    const retryMonitor = await freshIngress.startSignalIngressMonitor({
      accountId: "default",
      queue: queue as Parameters<typeof freshIngress.startSignalIngressMonitor>[0]["queue"],
      dispatch: async (retryEvent, lifecycle) => await retryHandler(retryEvent, lifecycle),
      runtime: { error: vi.fn(), log: vi.fn() },
    });

    try {
      await retryMonitor.receive(event);
      await retryMonitor.waitForIdle();
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
      expect(getReplyFromConfigMock).toHaveBeenCalledTimes(2);
      expect(sendMessageSignalMock.mock.calls.map(([, text]) => text)).toEqual([
        "retry me",
        "retry me",
      ]);
      expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(
        await queue.enqueue(pending.id, pending.payload, {
          receivedAt: pending.receivedAt,
          laneKey: pending.laneKey,
        }),
      ).toMatchObject({ kind: "completed", duplicate: true });

      await retryMonitor.receive(event);
      await retryMonitor.waitForIdle();
      expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    } finally {
      await retryMonitor.stop();
      freshPluginRuntime.resetPluginRuntimeStateForTest();
    }
  });
});
