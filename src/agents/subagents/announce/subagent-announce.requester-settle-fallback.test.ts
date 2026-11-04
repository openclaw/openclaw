import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { errorShapeFromError } from "../../../gateway/error-shape.js";
import { unwrapGatewayMethodDispatchResponse } from "../../../gateway/server-in-process-dispatch.js";
import {
  deliverRequesterStallFallback,
  isRequesterSettleWatchdogFailure,
} from "./subagent-announce.requester-settle-fallback.js";

const { append, direct } = vi.hoisted(() => ({ append: vi.fn(), direct: vi.fn() }));
vi.mock("./subagent-announce-completion-delivery.js", () => ({ deliverCompletionDirect: direct }));
vi.mock("../../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: append,
}));

const params = {
  requesterSessionKey: "agent:main:main",
  requesterSessionId: "requester-session",
  requesterLifecycleRevision: "revision-1",
  idempotencyKey: "cohort:watchdog-fallback",
  findings: "Completed child findings.",
  assertCurrent: () => {},
};

beforeEach(() => {
  append.mockReset();
  direct.mockReset();
});

const directDelivery = {
  cfg: {},
  deliveryTarget: { deliver: true, channel: "telegram", to: "chat:fixture" },
};

describe("requester stall fallback", () => {
  it.each([false, true])(
    "delivers only a generic notice when findings are private (external=%s)",
    async (external) => {
      append.mockResolvedValue({ ok: true });
      direct.mockResolvedValue({ delivered: true, path: "direct" });
      await deliverRequesterStallFallback({
        ...params,
        findings: undefined,
        ...(external ? { directDelivery } : {}),
      });
      const text = external
        ? expectDefined(direct.mock.calls[0], "direct fallback call")[0].preparedNotice
        : expectDefined(append.mock.calls[0], "transcript fallback call")[0].text;
      expect(text).toContain("retained privately");
      expect(text).not.toContain(params.findings);
    },
  );

  it("names retryable external nondelivery using the existing visible-reply contract", async () => {
    direct.mockResolvedValue({ delivered: false, path: "direct", disposition: "retryable" });
    await expect(
      deliverRequesterStallFallback({ ...params, directDelivery }),
    ).resolves.toMatchObject({ reason: "visible_reply_missing", disposition: "retryable" });
  });
  it("sends the retained result and truthful parent-stalled notice through the existing external sender", async () => {
    direct.mockResolvedValue({ delivered: true, path: "direct" });
    await expect(
      deliverRequesterStallFallback({ ...params, directDelivery }),
    ).resolves.toMatchObject({ delivered: true });
    expect(direct).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryTarget: directDelivery.deliveryTarget,
        directIdempotencyKey: params.idempotencyKey,
        contentKind: "completed_result",
        preparedNotice: expect.stringContaining(params.findings),
      }),
    );
    expect(expectDefined(direct.mock.calls[0], "direct fallback call")[0].preparedNotice).toContain(
      "follow-up turn stalled",
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("does not replace an ambiguous external receipt with a successful transcript fallback", async () => {
    const ambiguous = { delivered: false, path: "direct", disposition: "ambiguous" };
    direct.mockResolvedValue(ambiguous);
    await expect(deliverRequesterStallFallback({ ...params, directDelivery })).resolves.toBe(
      ambiguous,
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("reports unavailable external delivery rather than silently downgrading to a transcript", async () => {
    direct.mockResolvedValue(undefined);
    await expect(
      deliverRequesterStallFallback({ ...params, directDelivery }),
    ).resolves.toMatchObject({ delivered: false, disposition: "permanent_failure" });
    expect(append).not.toHaveBeenCalled();
  });
  it("recognizes the watchdog through the production Gateway error envelope", () => {
    const cause = Object.assign(new Error("Reply operation stalled"), {
      code: "OPENCLAW_SESSION_WATCHDOG",
    });
    try {
      unwrapGatewayMethodDispatchResponse("agent", {
        ok: false,
        error: errorShapeFromError(ErrorCodes.UNAVAILABLE, cause),
      });
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCodes.UNAVAILABLE, cause });
      expect(isRequesterSettleWatchdogFailure(error)).toBe(true);
      return;
    }
    throw new Error("Expected the Gateway response to throw");
  });

  it("recognizes only the watchdog code, not Stop or delivery suppression", () => {
    expect(isRequesterSettleWatchdogFailure({ code: "OPENCLAW_SESSION_WATCHDOG" })).toBe(true);
    for (const error of [
      undefined,
      new Error("OPENCLAW_SESSION_WATCHDOG"),
      { code: "ABORT_ERR", suppressCompletionDelivery: true },
    ]) {
      expect(isRequesterSettleWatchdogFailure(error)).toBe(false);
    }
  });

  it("appends the retained result with a stable idempotency key and current-session guard", async () => {
    append.mockResolvedValue({ ok: true });
    const current = vi.fn();
    await expect(
      deliverRequesterStallFallback({ ...params, assertCurrent: current }),
    ).resolves.toMatchObject({
      delivered: true,
      requesterVisibleFinalDelivered: true,
    });
    expect(current).toHaveBeenCalledOnce();
    const options = expectDefined(append.mock.calls[0], "transcript fallback call")[0];
    expect(options.runId).toBeUndefined();
    expect(
      options.beforeMessageWrite({
        message: { role: "assistant", content: [{ type: "text", text: params.findings }] },
      }),
    ).toEqual({
      role: "assistant",
      content: [{ type: "text", text: params.findings }],
      display: true,
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.requesterSessionKey,
        expectedSessionId: params.requesterSessionId,
        expectedLifecycleRevision: params.requesterLifecycleRevision,
        idempotencyKey: params.idempotencyKey,
        assertCurrent: current,
        text: expect.stringContaining(params.findings),
      }),
    );
  });

  it("leaves an uncertain append retryable under the same idempotency key", async () => {
    append.mockRejectedValueOnce(new Error("lost receipt")).mockResolvedValueOnce({ ok: true });
    await expect(deliverRequesterStallFallback(params)).resolves.toMatchObject({
      delivered: false,
      disposition: "retryable",
      reason: "visible_reply_missing",
    });
    await expect(deliverRequesterStallFallback(params)).resolves.toMatchObject({ delivered: true });
    expect(append.mock.calls.map(([call]) => call.idempotencyKey)).toEqual([
      params.idempotencyKey,
      params.idempotencyKey,
    ]);
  });

  it("does not append after requester authority is revoked", async () => {
    await expect(
      deliverRequesterStallFallback({
        ...params,
        assertCurrent: () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(append).not.toHaveBeenCalled();
  });
});
