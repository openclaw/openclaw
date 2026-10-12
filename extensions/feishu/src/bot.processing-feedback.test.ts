import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchMessage,
  mockCreateFeishuReplyDispatcher,
  mockDispatchReplyFromConfig,
  mockReadAllowFromStore,
  resetFeishuBotAuthorizationRuntime,
} from "./bot.dispatch.test-support.js";
import { createFeishuTestConfig, createFeishuTestEvent } from "./bot.test-support.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

describe("handleFeishuMessage processing feedback", () => {
  beforeEach(() => {
    resetFeishuBotAuthorizationRuntime();
  });
  const createProcessingStatus = () => ({
    queued: vi.fn(),
    included: vi.fn(),
    abandoned: vi.fn(),
    settled: vi.fn(),
  });
  const createStatusLifecycle = (): FeishuIngressLifecycle => ({
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(() => undefined),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
    onRunIncluded: vi.fn(),
  });
  const createStatusClaim = () => ({
    keys: ["processing-status"] as const,
    commit: vi.fn(async () => true),
    release: vi.fn(),
  });

  it("keeps a steered message processing status bound to the exact run after its dispatch returns", async () => {
    const status = createProcessingStatus();
    const sourceLifecycle = createStatusLifecycle();
    const ownerSettlement = createDeferred<void>();
    const includedRun = { runId: "run-active-exact", completion: ownerSettlement.promise };
    mockDispatchReplyFromConfig.mockImplementationOnce(async ({ replyOptions }) => {
      await replyOptions.turnAdoptionLifecycle.onAdopted();
      replyOptions.turnAdoptionLifecycle.onRunIncluded(includedRun);
      return { queuedFinal: false, counts: { final: 0 }, noVisibleReplyFallbackEligible: false };
    });
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({ messageId: "msg-steered-processing-status" }),
      processingStatus: status,
      turnAdoptionLifecycle: sourceLifecycle,
      processingClaim: createStatusClaim(),
    });
    expect(status.queued).toHaveBeenCalledOnce();
    expect(status.included).toHaveBeenCalledOnce();
    expect(status.included).toHaveBeenCalledWith(includedRun);
    expect(sourceLifecycle.onRunIncluded).toHaveBeenCalledWith(includedRun);
    expect(status.settled).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: status }),
    );
    ownerSettlement.resolve();
    await ownerSettlement.promise;
    expect(status.settled).not.toHaveBeenCalled();
  });

  it("keeps a deferred unadmitted message queued until the follow-up run actually includes it", async () => {
    const status = createProcessingStatus();
    let retainedLifecycle: FeishuIngressLifecycle | undefined;
    mockDispatchReplyFromConfig.mockImplementationOnce(async ({ replyOptions }) => {
      retainedLifecycle = replyOptions.turnAdoptionLifecycle;
      retainedLifecycle?.onDeferred();
      return { queuedFinal: false, counts: { final: 0 }, noVisibleReplyFallbackEligible: false };
    });
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({ messageId: "msg-deferred-processing-status" }),
      processingStatus: status,
      turnAdoptionLifecycle: createStatusLifecycle(),
      processingClaim: createStatusClaim(),
    });
    expect(status.included).not.toHaveBeenCalled();
    expect(status.settled).not.toHaveBeenCalled();
    const completion = createDeferred<void>();
    retainedLifecycle?.onRunIncluded?.({
      runId: "run-followup-exact",
      completion: completion.promise,
    });
    expect(status.included).toHaveBeenCalledWith({
      runId: "run-followup-exact",
      completion: completion.promise,
    });
    completion.resolve();
  });

  it.each(["final", "suppressed", "error"] as const)(
    "settles an unincluded processing receipt after %s dispatch outcome",
    async (outcome) => {
      const status = createProcessingStatus();
      const lifecycle = createStatusLifecycle();
      if (outcome === "error") {
        mockDispatchReplyFromConfig.mockRejectedValueOnce(new Error("final delivery failed"));
      } else {
        mockDispatchReplyFromConfig.mockResolvedValueOnce({
          queuedFinal: outcome === "final",
          counts: { final: outcome === "final" ? 1 : 0 },
          noVisibleReplyFallbackEligible: false,
        });
      }
      const pending = dispatchMessage({
        cfg: createFeishuTestConfig({ dmPolicy: "open" }),
        event: createFeishuTestEvent({ messageId: `msg-${outcome}-processing-status` }),
        processingStatus: status,
        turnAdoptionLifecycle: lifecycle,
        processingClaim: createStatusClaim(),
      });
      if (outcome === "error") {
        await expect(pending).rejects.toThrow("final delivery failed");
      } else {
        await pending;
      }
      expect(status.included).not.toHaveBeenCalled();
      expect(status.settled).toHaveBeenCalledOnce();
    },
  );

  it("settles a claimed user processing receipt when current DM policy gates agent dispatch", async () => {
    const status = createProcessingStatus();
    mockReadAllowFromStore.mockResolvedValue([]);
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "allowlist", allowFrom: ["ou-allowed"] }),
      event: createFeishuTestEvent({
        messageId: "msg-gated-processing-status",
        senderOpenId: "ou-denied",
      }),
      processingStatus: status,
      turnAdoptionLifecycle: createStatusLifecycle(),
      processingClaim: createStatusClaim(),
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(status.queued).not.toHaveBeenCalled();
    expect(status.included).not.toHaveBeenCalled();
    expect(status.settled).toHaveBeenCalledOnce();
  });
});
