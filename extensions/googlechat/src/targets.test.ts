import { describe, expect, it } from "vitest";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
} from "./targets.js";

describe("normalizeGoogleChatTarget", () => {
  it("normalizes provider prefixes", () => {
    expect(normalizeGoogleChatTarget("googlechat:users/123")).toBe("users/123");
    expect(normalizeGoogleChatTarget("google-chat:spaces/AAA")).toBe("spaces/AAA");
    expect(normalizeGoogleChatTarget("gchat:user:User@Example.com")).toBe("users/user@example.com");
  });

  it("normalizes email targets to users/<email>", () => {
    expect(normalizeGoogleChatTarget("User@Example.com")).toBe("users/user@example.com");
    expect(normalizeGoogleChatTarget("users/User@Example.com")).toBe("users/user@example.com");
  });

  it("preserves space targets", () => {
    expect(normalizeGoogleChatTarget("space:spaces/BBB")).toBe("spaces/BBB");
    expect(normalizeGoogleChatTarget("spaces/CCC")).toBe("spaces/CCC");
  });
});

describe("target helpers", () => {
  it("detects user and space targets", () => {
    expect(isGoogleChatUserTarget("users/abc")).toBe(true);
    expect(isGoogleChatSpaceTarget("spaces/abc")).toBe(true);
    expect(isGoogleChatUserTarget("spaces/abc")).toBe(false);
  });
});

describe("googlechat group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        googlechat: {
          groups: {
            "spaces/AAA": {
              requireMention: false,
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/AAA" })).toBe(false);
    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/BBB" })).toBe(true);
  });
});
