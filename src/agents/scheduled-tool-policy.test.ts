import { describe, expect, it } from "vitest";
import { resolveScheduledToolPolicyContext } from "./scheduled-tool-policy.js";

describe("resolveScheduledToolPolicyContext", () => {
  it("requires a persisted cap and a trusted owner session/account pair", () => {
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
        ownerAccountId: "work",
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
        ownerSessionKey: "agent:main:discord:group:ops",
      }),
    ).toBeUndefined();
  });

  it("normalizes the trusted owner for explicitly capped runs", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        ownerSessionKey: " agent:main:discord:group:ops ",
        ownerAccountId: " work ",
      }),
    ).toEqual({
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
  });
});
