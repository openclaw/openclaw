import { describe, expect, it } from "vitest";
import { resolveClickClackGroupPolicy } from "./group-policy.js";

describe("resolveClickClackGroupPolicy", () => {
  it("keeps bot-authored dispatch disabled by default", () => {
    expect(resolveClickClackGroupPolicy({ account: {}, channelId: "chn_unknown" })).toEqual({
      requireMention: false,
      mentionPatterns: [],
      allowBots: false,
      botLoopProtection: undefined,
    });
  });

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

  it("does not apply group bot policy to direct messages", () => {
    expect(
      resolveClickClackGroupPolicy({
        account: {
          allowBots: false,
          groups: { "*": { allowBots: "mentions" } },
        },
      }),
    ).toEqual({
      requireMention: false,
      mentionPatterns: [],
      allowBots: false,
      botLoopProtection: undefined,
    });
  });
});

describe("resolveClickClackGroupPolicy", () => {
  it("exact channel rule overrides groups['*']", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: false,
        groups: {
          "*": { requireMention: true },
          chn_exact: { requireMention: false },
        },
      },
      channelId: "chn_exact",
    });
    expect(result.requireMention).toBe(false);
  });

  it("inherits unspecified fields from the account policy", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: true,
        mentionPatterns: ["@account"],
        groups: {
          chn_exact: { mentionPatterns: ["@channel"] },
        },
      },
      channelId: " chn_exact ",
    });
    expect(result).toEqual({
      requireMention: true,
      mentionPatterns: ["@channel"],
      allowBots: false,
      botLoopProtection: undefined,
    });
  });

  it("inherits unspecified exact fields from the wildcard policy", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: false,
        mentionPatterns: ["@account"],
        groups: {
          "*": { requireMention: true, mentionPatterns: ["@wildcard"] },
          chn_exact: { mentionPatterns: ["@channel"] },
        },
      },
      channelId: "chn_exact",
    });
    expect(result).toEqual({
      requireMention: true,
      mentionPatterns: ["@channel"],
      allowBots: false,
      botLoopProtection: undefined,
    });
  });

  it("picks mentionPatterns from wildcard rule", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        mentionPatterns: ["@bot"],
        groups: {
          "*": { mentionPatterns: ["@wildbot"] },
        },
      },
      channelId: "chn_other",
    });
    expect(result.mentionPatterns).toEqual(["@wildbot"]);
  });

  it("unrelated channel does not inherit exact rule", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        groups: { chn_one: { requireMention: true } },
      },
      channelId: "chn_two",
    });
    expect(result).toEqual({
      requireMention: false,
      mentionPatterns: [],
      allowBots: false,
      botLoopProtection: undefined,
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
