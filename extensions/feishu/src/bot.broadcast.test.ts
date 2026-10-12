import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";
import { feishuDedupeState } from "./dedup-state.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

const emptyCounts = {
  delivered: 0,
  deliveredNotVisible: 0,
  cancelled: 0,
  failedBeforeSend: 0,
  failedAfterSend: 0,
};
const failedFinalReceipt = {
  counts: { tool: emptyCounts, block: emptyCounts, final: { ...emptyCounts, failedBeforeSend: 1 } },
  anyVisibleDelivered: false,
};

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

function mockBroadcastClaims(key: string) {
  const broadcastClaim = createReplayClaim(key);
  const susanClaim = createReplayClaim(`${key}-susan`);
  const mainClaim = createReplayClaim(`${key}-main`);
  vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
    kind: "claimed",
    handle:
      options?.namespace === "broadcast:susan"
        ? susanClaim
        : options?.namespace === "broadcast:main"
          ? mainClaim
          : broadcastClaim,
  }));
  return { broadcastClaim, susanClaim, mainClaim };
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

  function dispatchBroadcast(
    messageId: string,
    options: { turnAdoptionLifecycle?: FeishuIngressLifecycle } = {},
  ) {
    return handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({ messageId, text: "hello @bot", botMentioned: true }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      ...options,
    });
  }

  it("sends no-visible-reply fallback for active broadcast failed final delivery", async () => {
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:main:")
        ? {
            queuedFinal: true,
            counts: { final: 1 },
            settledReceipt: failedFinalReceipt,
          }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    const ensureNoVisibleReplyFallback = vi.fn();
    const activeDeliver = vi.fn(async () => undefined);
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: activeDeliver },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    await dispatchBroadcast("msg-broadcast-final-failed");

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
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

  it("skips no-visible-reply fallback for source-suppressed active broadcast dispatch", async () => {
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:main:")
        ? {
            queuedFinal: false,
            counts: { final: 0 },
            sourceReplyDeliveryMode: "message_tool_only",
            noVisibleReplyFallbackEligible: true,
          }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    await dispatchBroadcast("msg-broadcast-source-suppressed");

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg = createBroadcastConfig();
    cfg.channels = {
      feishu: {
        ...cfg.channels?.feishu,
        groups: { "oc-broadcast-group": { requireMention: false } },
      },
    };
    const event = createBroadcastEvent({ messageId: "msg-multi-account-dedup", text: "hello" });

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
    const claims = new Map([
      ["broadcast", [firstClaim, retryClaim]],
      ["broadcast:susan", [firstSusanClaim, retrySusanClaim]],
      ["broadcast:main", [mainClaim]],
    ]);
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => {
      const attempts = claims.get(options?.namespace ?? "");
      if (!attempts) {
        return { kind: "invalid" };
      }
      const handle = attempts.shift();
      return handle ? { kind: "claimed", handle } : { kind: "duplicate" };
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
    cfg.broadcast = { ...cfg.broadcast, strategy: "sequential" };

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
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims(
      "broadcast-fallback-failure",
    );
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
      dispatchBroadcast("msg-broadcast-fallback-failure", {
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
    const { broadcastClaim, susanClaim, mainClaim } =
      mockBroadcastClaims("broadcast-setup-failure");
    mockResolveStorePath.mockImplementation((_store, options?: { agentId?: string }) => {
      if (options?.agentId === "susan") {
        throw new Error("session path failed");
      }
      return "/tmp/feishu-session-store.json";
    });
    const cfg = createBroadcastConfig();
    cfg.broadcast = { ...cfg.broadcast, strategy: "sequential" };
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
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims("broadcast-undispatched");
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:susan:")
        ? { queuedFinal: false, counts: { final: 0 }, undispatched: true }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    const transport = createIngressLifecycle();

    await dispatchBroadcast("msg-broadcast-undispatched", {
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
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims(
      "broadcast-adoption-order",
    );
    const transport = createIngressLifecycle();
    const adoptionStarted = createDeferred<void>();
    const adoptionGate = createDeferred<void>();
    transport.calls.adopted.mockImplementationOnce(async () => {
      adoptionStarted.resolve();
      await adoptionGate.promise;
    });

    const handling = dispatchBroadcast("msg-broadcast-adoption-order", {
      turnAdoptionLifecycle: transport.lifecycle,
    });

    await adoptionStarted.promise;
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);

    adoptionGate.resolve();
    await handling;

    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(broadcastClaim.commit).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(broadcastClaim.release).not.toHaveBeenCalled();
  });

  it("cancels the shared claim without spending retry budget when a deferred lane is cancelled", async () => {
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims("broadcast-cancelled");
    let deferredLifecycle:
      | Pick<FeishuIngressLifecycle, "onDeferred" | "onCancelled" | "onAbandoned">
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
    const cancelled = vi.fn(async () => {});
    transport.lifecycle.onCancelled = cancelled;

    await dispatchBroadcast("msg-broadcast-cancelled", {
      turnAdoptionLifecycle: transport.lifecycle,
    });
    expect(transport.calls.deferred).toHaveBeenCalledTimes(1);

    // The reply lane settles a cleared queued turn through onCancelled and
    // falls back to abandonment only when the lifecycle cannot cancel.
    await (deferredLifecycle?.onCancelled
      ? deferredLifecycle.onCancelled()
      : deferredLifecycle?.onAbandoned());

    expect(cancelled).toHaveBeenCalledOnce();
    expect(transport.calls.abandoned).not.toHaveBeenCalled();
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(susanClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
  });

  it("waits for every independently deferred broadcast lane before adoption", async () => {
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims("broadcast-deferred");
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

    await dispatchBroadcast("msg-broadcast-deferred", {
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
