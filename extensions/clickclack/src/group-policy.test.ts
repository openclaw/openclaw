import { describe, expect, it } from "vitest";
import { resolveClickClackGroupPolicy } from "./group-policy.js";

describe("resolveClickClackGroupPolicy", () => {
  it("resolves exact, wildcard, and account bot policies independently", () => {
    expect(
      resolveClickClackGroupPolicy({
        account: {
          allowBots: false,
          botLoopProtection: { maxEventsPerWindow: 20, cooldownSeconds: 90 },
          groups: {
            "*": { allowBots: "mentions", botLoopProtection: { windowSeconds: 30 } },
            chn_exact: { botLoopProtection: { maxEventsPerWindow: 5 } },
          },
        },
        channelId: " chn_exact ",
      }),
    ).toEqual({
      requireMention: false,
      mentionPatterns: [],
      allowBots: "mentions",
      botLoopProtection: {
        maxEventsPerWindow: 5,
        windowSeconds: 30,
        cooldownSeconds: 90,
      },
    });
  });

  it("does not apply group policy to direct messages", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: false,
        mentionPatterns: ["@account"],
        groups: { "*": { requireMention: true, mentionPatterns: ["@group"] } },
      },
    });
    expect(result).toEqual({
      requireMention: false,
      mentionPatterns: ["@account"],
      allowBots: false,
      botLoopProtection: undefined,
    });
  });
});
