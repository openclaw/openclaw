import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveTelegramGroupRequireMention } from "./group-policy.js";

describe("resolveTelegramGroupRequireMention", () => {
  const cfg = {
    channels: {
      telegram: {
        groups: { "*": { requireMention: true } },
        accounts: {
          Work: {
            groups: {
              "-100123": {
                requireMention: false,
                topics: { "7": { requireMention: true } },
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;

  it("reads groups from a mixed-case account key", () => {
    expect(resolveTelegramGroupRequireMention({ cfg, groupId: "-100123", accountId: "work" })).toBe(
      false,
    );
    expect(
      resolveTelegramGroupRequireMention({
        cfg,
        groupId: "-100123:topic:7",
        accountId: "work",
      }),
    ).toBe(true);
  });
});
