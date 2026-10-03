import { describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { bindCliQuestionAnswerAuthority } from "./tool-authority.js";

describe("CLI question creator binding", () => {
  it("carries the host-issued profile and refuses it after its source is revoked", () => {
    let active = true;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "creator-profile",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!active) {
          throw new Error("source revoked");
        }
      },
    });
    const bind = bindCliQuestionAnswerAuthority({
      operation: undefined,
      snapshot: undefined,
      route: { provider: "fixture", model: "fixture" },
      fingerprint: undefined,
      readSource: () => source,
    });
    const question = bind("agent:main:question", () => {});
    expect(question.requesterProfileId).toBe("creator-profile");
    expect(() => question.assertActive()).not.toThrow();
    active = false;
    expect(() => question.assertActive()).toThrow("source revoked");
  });
});
