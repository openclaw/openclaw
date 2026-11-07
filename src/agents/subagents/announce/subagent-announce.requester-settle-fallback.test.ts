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
vi.mock("./subagent-announce-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-announce-completion-delivery.js")>()),
  deliverCompletionDirect: direct,
}));
vi.mock("../../../config/sessions/transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/transcript.js")>()),
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
const directDelivery = {
  cfg: {},
  deliveryTarget: { deliver: true, channel: "telegram", to: "chat:fixture" },
};

beforeEach(() => {
  append.mockReset().mockResolvedValue({ ok: true });
  direct.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
});

describe("requester stall fallback", () => {
  it.each([
    { external: false, findings: params.findings },
    { external: true, findings: params.findings },
    { external: false, findings: undefined },
    { external: true, findings: undefined },
  ])(
    "delivers a truthful visible notice (external=$external, findings=$findings)",
    async ({ external, findings }) => {
      const result = await deliverRequesterStallFallback({
        ...params,
        findings,
        ...(external ? { directDelivery } : {}),
      });
      expect(result.delivered).toBe(true);
      const options = expectDefined((external ? direct : append).mock.calls[0], "fallback call")[0];
      const text = external ? options.preparedNotice : options.text;
      expect(text).toContain("follow-up turn stalled");
      expect(text).toContain(findings ?? "retained privately");
      if (findings === undefined) {
        expect(text).not.toContain(params.findings);
      }
      expect(external ? append : direct).not.toHaveBeenCalled();
    },
  );

  it.each(["ambiguous", undefined])(
    "does not silently append after external nondelivery (%s)",
    async (disposition) => {
      const receipt = disposition ? { delivered: false, path: "direct", disposition } : undefined;
      direct.mockResolvedValue(receipt);
      const result = await deliverRequesterStallFallback({ ...params, directDelivery });
      expect(result).toMatchObject({
        delivered: false,
        disposition: disposition ?? "permanent_failure",
      });
      expect(result.reason).toBeUndefined();
      if (disposition === "ambiguous") {
        expect(result).toBe(receipt);
      }
      expect(append).not.toHaveBeenCalled();
    },
  );

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

  it("recognizes only the typed settle watchdog", () => {
    expect(isRequesterSettleWatchdogFailure({ code: "OPENCLAW_SESSION_WATCHDOG" })).toBe(true);
    for (const error of [
      undefined,
      new Error("OPENCLAW_SESSION_WATCHDOG"),
      { code: "ABORT_ERR", suppressCompletionDelivery: true },
    ]) {
      expect(isRequesterSettleWatchdogFailure(error)).toBe(false);
    }
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
