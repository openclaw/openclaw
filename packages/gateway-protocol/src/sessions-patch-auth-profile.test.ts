import { describe, expect, it } from "vitest";
import { validateSessionsPatchManyParams, validateSessionsPatchParams } from "./index.js";

describe("session auth-profile patch validation", () => {
  it("accepts only null for account selection clearing", () => {
    expect(validateSessionsPatchParams({ key: "agent:main:main", authProfileId: null })).toBe(true);
    expect(
      validateSessionsPatchManyParams({
        targets: [{ key: "agent:main:main" }],
        patch: { authProfileId: null },
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({ key: "agent:main:main", authProfileId: "openai:work" }),
    ).toBe(false);
  });
});
