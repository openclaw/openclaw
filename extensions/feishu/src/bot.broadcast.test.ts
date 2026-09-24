import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";
import type { FeishuMessageEvent } from "./bot.js";
import { feishuDedupeState } from "./dedup-state.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

const failedFinalReceipt = {
  counts: {
    tool: {
      delivered: 0,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 0,
      failedAfterSend: 0,
    },
    block: {
      delivered: 0,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 0,
      failedAfterSend: 0,
    },
    final: {
      delivered: 0,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 1,
      failedAfterSend: 0,
    },
  },
  anyVisibleDelivered: false,
} as const;

function createIngressLifecycle() {
  const calls = {
    adopted: vi.fn(async () => {}),
    deferred: vi.fn(),
    deferredHeartbeat: vi.fn(),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => {}),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: new AbortController().signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onDeferredHeartbeat: calls.deferredHeartbeat,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: calls.abandoned,
  };
  return { calls, lifecycle };
}

function createReplayClaim(key: string): FeishuMessageProcessingClaim {
  return {
    keys: [key],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
}

describe("broadcast dispatch", () => {
  const {
    builtInboundContextCalls,
    createBroadcastConfig,
    createBroadcastEvent,
    handleFeishuMessage,
    mockCreateFeishuReplyDispatcher,
    mockDispatchReply,
    mockGetChatInfo,
    mockResolveStorePath,
    resolvedTurnCalls,
  } = setupFeishuBroadcastTestHarness();

  it("keeps the observer adapter isolated from active delivery", async () => {
    const activeDeliver = vi.fn(async () => undefined);
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: activeDeliver },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(),
    });

    await handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-observer-isolation",
        text: "hello @bot",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    const observerTurn = resolvedTurnCalls.find(
      (turn) => (turn["admission"] as { kind?: string } | undefined)?.kind === "observeOnly",
    );
    const observerDelivery = observerTurn?.["delivery"] as
      | { deliver: (payload: unknown, context: unknown) => Promise<unknown> }
      | undefined;
    expect(observerDelivery?.deliver).not.toBe(activeDeliver);
    await expect(observerDelivery?.deliver({}, {})).resolves.toEqual({ visibleReplySent: false });
    expect(activeDeliver).not.toHaveBeenCalled();
  });

  it("sends no-visible-reply fallback for active broadcast zero-final dispatch", async () => {
    mockDispatchReply
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { final: 0 },
        noVisibleReplyFallbackEligible: true,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-zero-final",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
  });

  it("sends no-visible-reply fallback for active broadcast failed final delivery", async () => {
    mockDispatchReply
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: true,
        counts: { final: 1 },
        settledReceipt: failedFinalReceipt,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-final-failed",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
  });

  it("skips no-visible-reply fallback for source-suppressed active broadcast dispatch", async () => {
    mockDispatchReply
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { final: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
        noVisibleReplyFallbackEligible: true,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-source-suppressed",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-multi-account-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchReply).toHaveBeenCalledTimes(2);

    mockDispatchReply.mockClear();
    mockGetChatInfo.mockClear();
    builtInboundContextCalls.length = 0;

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });
    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("abandons a failed broadcast claim and re-dispatches it on redelivery", async () => {
    const firstClaim = createReplayClaim("broadcast-first-attempt");
    const retryClaim = createReplayClaim("broadcast-retry");
    const firstSusanClaim = createReplayClaim("broadcast-susan-first-attempt");
    const retrySusanClaim = createReplayClaim("broadcast-susan-retry");
    const mainClaim = createReplayClaim("broadcast-main");
    let broadcastAttempt = 0;
    let susanAttempt = 0;
    let mainAttempt = 0;
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => {
      if (options?.namespace === "broadcast") {
        broadcastAttempt += 1;
        return {
          kind: "claimed",
          handle: broadcastAttempt === 1 ? firstClaim : retryClaim,
        };
      }
      if (options?.namespace === "broadcast:susan") {
        susanAttempt += 1;
        return {
          kind: "claimed",
          handle: susanAttempt === 1 ? firstSusanClaim : retrySusanClaim,
        };
      }
      if (options?.namespace === "broadcast:main") {
        mainAttempt += 1;
        return mainAttempt === 1 ? { kind: "claimed", handle: mainClaim } : { kind: "duplicate" };
      }
      return { kind: "invalid" };
    });
    mockDispatchReply
      .mockRejectedValueOnce(new Error("observer dispatch failed"))
      .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-redelivery",
      text: "retry me",
      botMentioned: true,
    });
    const firstTransport = createIngressLifecycle();
    const cfg = createBroadcastConfig();
    (cfg.broadcast as Record<string, unknown>).strategy = "sequential";

    await expect(
      handleFeishuMessage({
        cfg,
        event,
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: firstTransport.lifecycle,
      }),
    ).rejects.toThrow("observer dispatch failed");

    expect(mockDispatchReply).toHaveBeenCalledTimes(2);
    expect(firstClaim.commit).not.toHaveBeenCalled();
    expect(firstClaim.release).toHaveBeenCalledTimes(1);
    expect(firstSusanClaim.commit).not.toHaveBeenCalled();
    expect(firstSusanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.release).not.toHaveBeenCalled();
    expect(firstTransport.calls.adopted).not.toHaveBeenCalled();
    expect(firstTransport.calls.abandoned).toHaveBeenCalledTimes(1);

    mockDispatchReply.mockClear();
    const retryTransport = createIngressLifecycle();
    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: retryTransport.lifecycle,
    });

    // The adopted main lane stays committed; only failed Susan re-dispatches.
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(retryTransport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(retryTransport.calls.abandoned).not.toHaveBeenCalled();
    expect(retryClaim.release).not.toHaveBeenCalled();
    expect(retryClaim.commit).toHaveBeenCalledTimes(1);
    expect(retrySusanClaim.commit).toHaveBeenCalledTimes(1);
    expect(retrySusanClaim.release).not.toHaveBeenCalled();
  });

  it("keeps an adopted active lane committed when its no-visible fallback fails", async () => {
    const broadcastClaim = createReplayClaim("broadcast-fallback-failure");
    const susanClaim = createReplayClaim("broadcast-fallback-failure-susan");
    const mainClaim = createReplayClaim("broadcast-fallback-failure-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:main:")
        ? {
            queuedFinal: false,
            counts: { final: 0 },
            noVisibleReplyFallbackEligible: true,
          }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(async () => {
        throw new Error("fallback send failed");
      }),
    });
    const transport = createIngressLifecycle();

    await expect(
      handleFeishuMessage({
        cfg: createBroadcastConfig(),
        event: createBroadcastEvent({
          messageId: "msg-broadcast-fallback-failure",
          text: "fallback must retry",
          botMentioned: true,
        }),
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: transport.lifecycle,
      }),
    ).rejects.toThrow("fallback send failed");

    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.release).not.toHaveBeenCalled();
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("releases an agent claim when broadcast lane setup fails", async () => {
    const broadcastClaim = createReplayClaim("broadcast-setup-failure");
    const susanClaim = createReplayClaim("broadcast-setup-failure-susan");
    const mainClaim = createReplayClaim("broadcast-setup-failure-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    mockResolveStorePath.mockImplementation((_store, options?: { agentId?: string }) => {
      if (options?.agentId === "susan") {
        throw new Error("session path failed");
      }
      return "/tmp/feishu-session-store.json";
    });
    const cfg = createBroadcastConfig();
    (cfg.broadcast as Record<string, unknown>).strategy = "sequential";
    const transport = createIngressLifecycle();

    await expect(
      handleFeishuMessage({
        cfg,
        event: createBroadcastEvent({
          messageId: "msg-broadcast-setup-failure",
          text: "setup must release",
          botMentioned: true,
        }),
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: transport.lifecycle,
      }),
    ).rejects.toThrow("session path failed");

    expect(susanClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("abandons the shared claim when an agent lane is not dispatched", async () => {
    const broadcastClaim = createReplayClaim("broadcast-undispatched");
    const susanClaim = createReplayClaim("broadcast-undispatched-susan");
    const mainClaim = createReplayClaim("broadcast-undispatched-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:susan:")
        ? { queuedFinal: false, counts: { final: 0 }, undispatched: true }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    const transport = createIngressLifecycle();

    await handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-undispatched",
        text: "do not tombstone",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    expect(susanClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("commits the shared broadcast claim only after transport adoption", async () => {
    const broadcastClaim = createReplayClaim("broadcast-adoption-order");
    const susanClaim = createReplayClaim("broadcast-adoption-order-susan");
    const mainClaim = createReplayClaim("broadcast-adoption-order-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    const transport = createIngressLifecycle();
    let finishAdoption!: () => void;
    const adoptionGate = new Promise<void>((resolve) => {
      finishAdoption = resolve;
    });
    transport.calls.adopted.mockImplementationOnce(async () => await adoptionGate);

    const handling = handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-adoption-order",
        text: "adopt before dedupe",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    await vi.waitFor(() => expect(transport.calls.adopted).toHaveBeenCalledTimes(1));
    expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);

    finishAdoption();
    await handling;

    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(broadcastClaim.commit).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(broadcastClaim.release).not.toHaveBeenCalled();
  });

  it("waits for every independently deferred broadcast lane before adoption", async () => {
    const broadcastClaim = createReplayClaim("broadcast-deferred");
    const susanClaim = createReplayClaim("broadcast-deferred-susan");
    const mainClaim = createReplayClaim("broadcast-deferred-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    let deferredLifecycle:
      | Pick<
          FeishuIngressLifecycle,
          "onAdopted" | "onDeferred" | "onDeferredHeartbeat" | "onAbandoned"
        >
      | undefined;
    mockDispatchReply.mockImplementation(async ({ ctx, replyOptions }) => {
      if (String(ctx.SessionKey).startsWith("agent:susan:")) {
        deferredLifecycle = replyOptions?.turnAdoptionLifecycle;
        deferredLifecycle?.onDeferred();
        return { queuedFinal: false, counts: { final: 1 }, deferAdoption: true };
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });
    const transport = createIngressLifecycle();

    await handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-deferred",
        text: "wait for every lane",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    expect(transport.calls.deferred).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    deferredLifecycle?.onDeferredHeartbeat?.();
    expect(transport.calls.deferredHeartbeat).toHaveBeenCalledOnce();
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(susanClaim.commit).not.toHaveBeenCalled();

    await deferredLifecycle?.onAdopted();

    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
  });
});
