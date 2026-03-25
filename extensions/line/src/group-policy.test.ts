import { describe, expect, it } from "vitest";
import { resolveLineGroupRequireMention } from "./group-policy.js";

describe("line group policy", () => {
  it("matches raw and prefixed LINE group keys for requireMention", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            "room:r123": {
              requireMention: false,
            },
            "group:g123": {
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

    expect(resolveLineGroupRequireMention({ cfg, groupId: "r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "room:r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "group:g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "other" })).toBe(true);
  });

  it("uses account-scoped prefixed LINE group config for requireMention", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            "*": {
              requireMention: true,
            },
          },
          accounts: {
            work: {
              groups: {
                "group:g123": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveLineGroupRequireMention({ cfg, groupId: "g123", accountId: "work" })).toBe(false);
  });
});
