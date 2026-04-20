import { describe, expect, it } from "vitest";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";

describe("shouldInjectHeartbeatPromptForTrigger", () => {
  it("injects the heartbeat prompt on heartbeat-triggered runs", () => {
    expect(shouldInjectHeartbeatPromptForTrigger("heartbeat")).toBe(true);
  });

  // Regression: the heartbeat system prompt instructs the model to reply
  // exactly "HEARTBEAT_OK" when nothing is pending. If that prompt leaks into
  // a user-triggered turn, the model can pattern-match the literal HEARTBEAT_OK
  // token (which the delivery runtime then suppresses, so the user sees
  // silence) or hallucinate a "[object Object]" serialization error as it
  // tries to reconcile the heartbeat instruction with a real user message.
  // See issue #69079 and its parent #50797.
  it.each([
    ["user"] as const,
    ["manual"] as const,
    ["cron"] as const,
    ["memory"] as const,
    ["overflow"] as const,
  ])("does not inject the heartbeat prompt on %s-triggered runs", (trigger) => {
    expect(shouldInjectHeartbeatPromptForTrigger(trigger)).toBe(false);
  });

  it("does not inject the heartbeat prompt when no trigger is supplied", () => {
    // Defense-in-depth: if a new call site lands without a trigger, it should
    // fall through to the safe default rather than spuriously injecting
    // heartbeat instructions.
    expect(shouldInjectHeartbeatPromptForTrigger(undefined)).toBe(false);
  });
});
