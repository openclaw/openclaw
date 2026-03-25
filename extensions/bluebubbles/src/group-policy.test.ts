import { describe, expect, it } from "vitest";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./group-policy.js";

describe("bluebubbles group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          groups: {
            "chat:primary": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:primary" })).toBe(false);
    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:primary" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});
