import { expect } from "vitest";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";

export async function admitIMessageContext(
  overrides: Parameters<typeof createInboundDecisionParams>[0] = {},
) {
  const params = createInboundDecisionParams(overrides);
  const { resolveIMessageInboundDecision, buildIMessageInboundContext } =
    await import("./inbound-processing.js");
  const decision = await resolveIMessageInboundDecision(params);
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected context fixture admission");
  }
  return {
    decision,
    context: () => buildIMessageInboundContext({ ...params, decision, accountService: undefined }),
  };
}
