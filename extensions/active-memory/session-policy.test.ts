import { describe, expect, it } from "vitest";
import { isEligibleInteractiveSession } from "./session-policy.js";

describe("Active Memory interactive session eligibility", () => {
  it.each([
    ["agent:main:internal-session-effects:skill-workshop-review-example", false],
    [" AGENT:MAIN:INTERNAL-SESSION-EFFECTS:review-example ", false],
    ["agent:main:main", true],
    ["agent:main:webchat:internal-session-effects:room", true],
  ] as const)("classifies webchat session %s as eligible=%s", (sessionKey, eligible) => {
    expect(
      isEligibleInteractiveSession({ trigger: "user", messageProvider: "webchat", sessionKey }),
    ).toBe(eligible);
  });
});
