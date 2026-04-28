import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import {
  extractSlackSubteamMentionIds,
  matchesConfiguredSubteamMention,
} from "./subteam-mentions.js";

describe("extractSlackSubteamMentionIds", () => {
  it("returns empty for empty/no-match text", () => {
    expect(extractSlackSubteamMentionIds("")).toEqual([]);
    expect(extractSlackSubteamMentionIds("hello @everyone")).toEqual([]);
  });

  it("extracts a single subteam token", () => {
    expect(
      extractSlackSubteamMentionIds("hi <!subteam^S0B07LS458B|cg-agents> there"),
    ).toEqual(["S0B07LS458B"]);
  });

  it("extracts and dedupes multiple subteam tokens", () => {
    expect(
      extractSlackSubteamMentionIds(
        "<!subteam^SAAA> and <!subteam^SBBB|x> and <!subteam^SAAA|x>",
      ).sort(),
    ).toEqual(["SAAA", "SBBB"]);
  });

  it("uppercases extracted ids", () => {
    expect(extractSlackSubteamMentionIds("<!subteam^sabc>")).toEqual(["SABC"]);
  });
});

describe("matchesConfiguredSubteamMention", () => {
  const cfgWith = (params: {
    global?: string[];
    agents?: Record<string, string[]>;
  }): OpenClawConfig =>
    ({
      messages: params.global
        ? { groupChat: { subteamMentions: params.global } }
        : undefined,
      agents: {
        list: Object.entries(params.agents ?? {}).map(([id, list]) => ({
          id,
          groupChat: { subteamMentions: list },
        })),
      },
    }) as unknown as OpenClawConfig;

  it("returns false when no subteam ids in message", () => {
    expect(
      matchesConfiguredSubteamMention(
        [],
        cfgWith({ global: ["S0B07LS458B"] }),
        undefined,
      ),
    ).toBe(false);
  });

  it("matches against global list when no agent override", () => {
    expect(
      matchesConfiguredSubteamMention(
        ["S0B07LS458B"],
        cfgWith({ global: ["S0B07LS458B"] }),
        undefined,
      ),
    ).toBe(true);
  });

  it("matches against agent-specific list", () => {
    expect(
      matchesConfiguredSubteamMention(
        ["S0B07LS458B"],
        cfgWith({ agents: { jack: ["S0B07LS458B"] } }),
        "jack",
      ),
    ).toBe(true);
  });

  it("agent override shadows global list (no match if agent list omits id)", () => {
    expect(
      matchesConfiguredSubteamMention(
        ["S0B07LS458B"],
        cfgWith({
          global: ["S0B07LS458B"],
          agents: { jack: ["SOTHER"] },
        }),
        "jack",
      ),
    ).toBe(false);
  });

  it("empty agent list explicitly opts out (does not fall back to global)", () => {
    expect(
      matchesConfiguredSubteamMention(
        ["S0B07LS458B"],
        cfgWith({ global: ["S0B07LS458B"], agents: { jack: [] } }),
        "jack",
      ),
    ).toBe(false);
  });

  it("is case-insensitive on configured ids", () => {
    expect(
      matchesConfiguredSubteamMention(
        ["S0B07LS458B"],
        cfgWith({ global: ["s0b07ls458b"] }),
        undefined,
      ),
    ).toBe(true);
  });
});
