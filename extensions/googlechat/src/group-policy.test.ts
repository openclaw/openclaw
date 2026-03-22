import { describe, expect, it } from "vitest";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";

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
