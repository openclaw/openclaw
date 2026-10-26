import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";
import { feishuDedupeState } from "./dedup-state.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

const failedFinalReceipt = {
  counts: { final: { failedBeforeSend: 1 } },
  anyVisibleDelivered: false,
};

function createIngressLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onDeferredHeartbeat: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
  } satisfies FeishuIngressLifecycle;
}

function createReplayClaim(key: string): FeishuMessageProcessingClaim {
  return {
    keys: [key],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
}

function expectClaim(claim: FeishuMessageProcessingClaim, committed: boolean) {
  expect(claim.commit).toHaveBeenCalledTimes(committed ? 1 : 0);
  expect(claim.release).toHaveBeenCalledTimes(committed ? 0 : 1);
}

function mockBroadcastClaims(key: string, redelivery = false) {
  const broadcastClaim = createReplayClaim(key);
  const susanClaim = createReplayClaim(`${key}-susan`);
  const mainClaim = createReplayClaim(`${key}-main`);
  const retryClaim = createReplayClaim(`${key}-retry`);
  const retrySusanClaim = createReplayClaim(`${key}-susan-retry`);
  const claims = new Map([
    ["broadcast", redelivery ? [broadcastClaim, retryClaim] : [broadcastClaim]],
    ["broadcast:susan", redelivery ? [susanClaim, retrySusanClaim] : [susanClaim]],
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
  return { broadcastClaim, susanClaim, mainClaim, retryClaim, retrySusanClaim };
}

describe("broadcast dispatch", () => {
  const {
    createBroadcastConfig,
    createBroadcastEvent,
    createReplyDispatcher,
    handleFeishuMessage,
    mockCreateFeishuReplyDispatcher,
    mockDispatchReply,
    mockGetChatInfo,
    mockResolveStorePath,
    resolvedTurnCalls,
  } = setupFeishuBroadcastTestHarness();

  function mockActiveDispatcher(ensureNoVisibleReplyFallback = vi.fn()) {
    const dispatcher = { ...createReplyDispatcher(), ensureNoVisibleReplyFallback };
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce(dispatcher);
    return { ...dispatcher.delivery, ensureNoVisibleReplyFallback };
  }

  function mockAgentReply(agent: "main" | "susan", result: unknown) {
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith(`agent:${agent}:`)
        ? result
        : { queuedFinal: false, counts: { final: 1 } },
    );
  }

  function dispatchBroadcast(
    messageId: string,
    options: Partial<Parameters<typeof handleFeishuMessage>[0]> = {},
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
    mockAgentReply("main", {
      queuedFinal: true,
      counts: { final: 1 },
      settledReceipt: failedFinalReceipt,
    });
    const { deliver: activeDeliver, ensureNoVisibleReplyFallback } = mockActiveDispatcher();
    await dispatchBroadcast("msg-broadcast-final-failed");

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
    const observerDelivery = resolvedTurnCalls.find(
      (turn) => turn.admission?.kind === "observeOnly",
    )?.delivery;
    expect(observerDelivery?.deliver).not.toBe(activeDeliver);
    await expect(observerDelivery?.deliver({}, { kind: "final" })).resolves.toEqual({
      visibleReplySent: false,
    });
    expect(activeDeliver).not.toHaveBeenCalled();
  });

  it("skips no-visible-reply fallback for source-suppressed active broadcast dispatch", async () => {
    mockAgentReply("main", {
      queuedFinal: false,
      counts: { final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
      noVisibleReplyFallbackEligible: true,
    });
    const { ensureNoVisibleReplyFallback } = mockActiveDispatcher();
    await dispatchBroadcast("msg-broadcast-source-suppressed");

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg = createBroadcastConfig(false);
    const event = createBroadcastEvent({ messageId: "msg-multi-account-dedup", text: "hello" });

    const params = { cfg, event, botOpenId: undefined };
    await dispatchBroadcast("msg-multi-account-dedup", { ...params, accountId: "account-A" });
    expect(mockDispatchReply).toHaveBeenCalledTimes(2);

    mockDispatchReply.mockClear();
    mockGetChatInfo.mockClear();

    await dispatchBroadcast("msg-multi-account-dedup", { ...params, accountId: "account-B" });
    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("abandons a failed broadcast claim and re-dispatches it on redelivery", async () => {
    const {
      broadcastClaim: firstClaim,
      susanClaim: firstSusanClaim,
      mainClaim,
      retryClaim,
      retrySusanClaim,
    } = mockBroadcastClaims("redelivery", true);
    mockDispatchReply
      .mockRejectedValueOnce(new Error("observer dispatch failed"))
      .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    const firstTransport = createIngressLifecycle();
    const cfg = createBroadcastConfig();
    cfg.broadcast = { ...cfg.broadcast, strategy: "sequential" };

    await expect(
      dispatchBroadcast("redelivery", { cfg, turnAdoptionLifecycle: firstTransport }),
    ).rejects.toThrow("observer dispatch failed");

    expect(mockDispatchReply).toHaveBeenCalledTimes(2);
    expectClaim(firstClaim, false);
    expectClaim(firstSusanClaim, false);
    expectClaim(mainClaim, true);
    expect(firstTransport.onAdopted).not.toHaveBeenCalled();
    expect(firstTransport.onAbandoned).toHaveBeenCalledTimes(1);

    mockDispatchReply.mockClear();
    const retryTransport = createIngressLifecycle();
    await dispatchBroadcast("redelivery", { cfg, turnAdoptionLifecycle: retryTransport });

    // The adopted main lane stays committed; only failed Susan re-dispatches.
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(retryTransport.onAdopted).toHaveBeenCalledTimes(1);
    expect(retryTransport.onAbandoned).not.toHaveBeenCalled();
    expectClaim(retryClaim, true);
    expectClaim(retrySusanClaim, true);
  });

  it.each([
    ["fallback-failure", "fallback send failed"],
    ["setup-failure", "session path failed"],
    ["undispatched", undefined],
  ] as const)("settles each lane independently after %s", async (failure, error) => {
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims(failure);
    const cfg = createBroadcastConfig();
    if (failure === "fallback-failure") {
      mockAgentReply("main", {
        queuedFinal: false,
        counts: { final: 0 },
        noVisibleReplyFallbackEligible: true,
      });
      mockActiveDispatcher(vi.fn().mockRejectedValue(new Error(error)));
    } else if (failure === "setup-failure") {
      cfg.broadcast = { ...cfg.broadcast, strategy: "sequential" };
      mockResolveStorePath.mockImplementation((_store, options?: { agentId?: string }) => {
        if (options?.agentId === "susan") {
          throw new Error(error);
        }
        return "/tmp/feishu-session-store.json";
      });
    } else {
      mockAgentReply("susan", { queuedFinal: false, counts: { final: 0 }, undispatched: true });
    }
    const transport = createIngressLifecycle();
    const handling = dispatchBroadcast(failure, { cfg, turnAdoptionLifecycle: transport });
    if (error) {
      await expect(handling).rejects.toThrow(error);
    } else {
      await handling;
    }
    expectClaim(susanClaim, failure === "fallback-failure");
    expectClaim(mainClaim, true);
    expectClaim(broadcastClaim, false);
    if (failure === "undispatched") {
      expect(transport.onAdopted).not.toHaveBeenCalled();
    }
    expect(transport.onAbandoned).toHaveBeenCalledTimes(1);
  });

  it("commits the shared broadcast claim only after transport adoption", async () => {
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims("adoption-order");
    const transport = createIngressLifecycle();
    const adoptionStarted = createDeferred<void>();
    const adoptionGate = createDeferred<void>();
    transport.onAdopted.mockImplementationOnce(async () => {
      adoptionStarted.resolve();
      await adoptionGate.promise;
    });

    const handling = dispatchBroadcast("adoption-order", { turnAdoptionLifecycle: transport });

    await adoptionStarted.promise;
    expect(transport.onAdopted).toHaveBeenCalledTimes(1);
    expect(transport.onAdoptionFinalizing).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);

    adoptionGate.resolve();
    await handling;

    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.onAdopted.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(broadcastClaim.commit).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(broadcastClaim.release).not.toHaveBeenCalled();
  });

  it("waits for every independently deferred broadcast lane before adoption", async () => {
    const { broadcastClaim, susanClaim, mainClaim } = mockBroadcastClaims("deferred");
    let deferredLifecycle: NonNullable<
      (typeof resolvedTurnCalls)[number]["replyOptions"]
    >["turnAdoptionLifecycle"];
    mockDispatchReply.mockImplementation(async ({ ctx, replyOptions }) => {
      if (String(ctx.SessionKey).startsWith("agent:susan:")) {
        deferredLifecycle = replyOptions?.turnAdoptionLifecycle;
        deferredLifecycle?.onDeferred?.();
        return { queuedFinal: false, counts: { final: 1 }, deferAdoption: true };
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });
    const transport = createIngressLifecycle();

    await dispatchBroadcast("deferred", { turnAdoptionLifecycle: transport });

    expect(transport.onDeferred).toHaveBeenCalledTimes(1);
    expect(transport.onAdopted).not.toHaveBeenCalled();
    deferredLifecycle?.onDeferredHeartbeat?.();
    expect(transport.onDeferredHeartbeat).toHaveBeenCalledOnce();
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(susanClaim.commit).not.toHaveBeenCalled();

    await deferredLifecycle?.onAdopted();

    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.onAdopted).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
  });
});
