import { describe, expect, it } from "vitest";
import { resolveScheduledToolPolicyContext } from "./scheduled-tool-policy.js";

describe("resolveScheduledToolPolicyContext", () => {
  it("requires both a persisted cap and a trusted owner session", () => {
    expect(
      resolveScheduledToolPolicyContext({
        ownerSessionKey: "agent:main:discord:group:ops",
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
        ownerSessionKey: "   ",
      }),
    ).toBeUndefined();
  });

  it("normalizes the trusted owner for explicitly capped runs", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        ownerSessionKey: " agent:main:discord:group:ops ",
      }),
    ).toEqual({ ownerSessionKey: "agent:main:discord:group:ops" });
  });
});
