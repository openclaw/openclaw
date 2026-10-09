import { describe, expect, it, vi } from "vitest";
import { createDirectAnnounceResponseClassifier } from "./subagent-announce-direct-response.js";

describe("admitted harness completion settlement", () => {
  it.each([
    "silent",
    "tool-only",
    "side-effect",
    "unadmitted",
    "required",
    "private",
    "subagent",
    "failed",
    "aborted",
    "yielded",
    "continuation",
    "empty",
    "retired",
  ] as const)("settles only a current successful optional completion: %s", async (outcome) => {
    const assertCurrent = vi.fn(() => {
      if (outcome === "retired") {
        throw new Error("source owner retired");
      }
    });
    const classifier = createDirectAnnounceResponseClassifier({
      params: {
        sourceTool: "agent_harness_completion",
        expectsCompletionMessage: true,
        requireVisibleReply: outcome === "required",
        requesterIsSubagent: outcome === "subagent",
      },
      parentOnly: outcome === "private",
      requesterSessionBound: outcome === "private",
      deliveryTarget: { channel: "qa-channel", to: "dm:proof-user" },
      shouldDeliverAgentFinal: true,
      requiresMessageToolDelivery: outcome === "tool-only",
      isSubagentCompletion: outcome === "subagent",
      hasSuccessfulTrustedSubagentNoOutputCompletion: false,
      hasRequiredSubagentNoOutputCompletion: false,
      subagentDirectMessageCompletionRequiresMessageTool: false,
      effectiveDirectOrigin: { channel: "qa-channel", to: "dm:proof-user" },
      requesterSessionOrigin: undefined,
      textCompletionDirectDeliveryKind: "completed_result",
      tryTextCompletionDirectDelivery: async () => undefined,
      assertHarnessCompletionSourceCurrent: outcome === "unadmitted" ? undefined : assertCurrent,
    });
    const response = {
      status: outcome === "failed" ? "error" : "ok",
      result: {
        payloads: [],
        didSendViaMessagingTool: outcome === "side-effect",
        meta: {
          terminalReply: { disposition: outcome === "empty" ? "empty" : "silent" },
          aborted: outcome === "aborted",
          yielded: outcome === "yielded",
          continuationPending: outcome === "continuation",
        },
        deliveryStatus: {
          status: "suppressed",
          reason: "no_visible_payload",
          resultCount: 0,
        },
      },
    };
    if (outcome === "retired") {
      expect(() => classifier(response)).toThrow("source owner retired");
      return;
    }
    const result = await classifier(response);
    expect(result.delivered).toBe(outcome === "silent" || outcome === "tool-only");
    expect(result.requesterVisibleFinalDelivered).toBeUndefined();
    expect(assertCurrent).toHaveBeenCalledTimes(
      outcome === "silent" || outcome === "tool-only" ? 1 : 0,
    );
  });
});
