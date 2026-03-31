import { describe, expect, it } from "vitest";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";

describe("pickSandboxToolPolicy", () => {
  it("returns undefined when neither allow nor deny is configured", () => {
    expect(pickSandboxToolPolicy({})).toBeUndefined();
  });

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

  it("merges allow and alsoAllow when both are present", () => {
    expect(
      pickSandboxToolPolicy({
        allow: ["read"],
        alsoAllow: ["write"],
      }),
    ).toEqual({
      allow: ["read", "write"],
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

  it("passes deny through unchanged", () => {
    expect(
      pickSandboxToolPolicy({
        deny: ["exec"],
      }),
    ).toEqual({
      allow: undefined,
      deny: ["exec"],
    });
  });
});
