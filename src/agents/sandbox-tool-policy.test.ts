import { describe, expect, it } from "vitest";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";

describe("pickSandboxToolPolicy", () => {
  it("treats alsoAllow without allow as a restrictive allowlist", () => {
    expect(
      pickSandboxToolPolicy({
        alsoAllow: ["web_search"],
      }),
    ).toEqual({
      allow: ["web_search"],
      deny: undefined,
    });
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    expect(
      pickSandboxToolPolicy({
        allow: [],
        alsoAllow: ["web_search"],
      }),
    ).toEqual({
      allow: [],
      deny: undefined,
    });
  });
});
