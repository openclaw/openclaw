import { describe, expect, it } from "vitest";
import { lineConfig as config } from "./channel-account.test-support.js";
import { linePlugin } from "./channel.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import type { LineConfig } from "./types.js";

describe("resolveLineGroupConfigEntry", () => {
  it("matches raw, prefixed, and wildcard group config entries", () => {
    const groups = {
      "group:g1": { requireMention: false },
      "room:r1": { systemPrompt: "Room prompt" },
      "*": { requireMention: true },
    };

    expect([
      resolveLineGroupConfigEntry(groups, { groupId: "g1" }),
      resolveLineGroupConfigEntry(groups, { roomId: "r1" }),
      resolveLineGroupConfigEntry(groups, { groupId: "missing" }),
    ]).toEqual([
      { requireMention: false },
      { requireMention: true, systemPrompt: "Room prompt" },
      { requireMention: true },
    ]);
  });

  it("keeps the settings an operator only wrote on the wildcard", () => {
    const groups = {
      "*": { requireMention: false, systemPrompt: "House rules" },
      C1: { skills: ["deploy"] },
    };

    expect(resolveLineGroupConfigEntry(groups, { groupId: "C1" })).toEqual({
      requireMention: false,
      systemPrompt: "House rules",
      skills: ["deploy"],
    });
  });

  it("resolves mentions the same way the channel reports them", () => {
    const groups: NonNullable<LineConfig["groups"]> = {
      "*": { requireMention: false },
      C1: { systemPrompt: "team bot" },
    };
    const cfg = config({ groups });

    const entry = resolveLineGroupConfigEntry(groups, { groupId: "C1" });
    expect(entry?.requireMention !== false).toBe(
      linePlugin.groups?.resolveRequireMention?.({ cfg, accountId: null, groupId: "C1" }),
    );
  });
});

describe("line group policy", () => {
  it("preserves candidate precedence and falls back to wildcard", () => {
    const cfg = config({
      groups: {
        same: { requireMention: false },
        "group:same": { requireMention: true },
        "room:same": { requireMention: true },
        "group:typed": { requireMention: false },
        "room:typed": { requireMention: true },
        "*": { requireMention: false },
      },
    });

    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "same" })).toBe(false);
    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "room:same" })).toBe(false);
    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "group:same" })).toBe(false);
    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "typed" })).toBe(false);
    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "group:typed" })).toBe(false);
    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "room:typed" })).toBe(true);
    expect(linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "other" })).toBe(false);
  });

  it("uses account-scoped prefixed LINE group config for requireMention", () => {
    const cfg = config({
      groups: { "*": { requireMention: true } },
      accounts: {
        work: { groups: { "group:g123": { requireMention: false } } },
      },
    });

    expect(
      linePlugin.groups?.resolveRequireMention?.({ cfg, groupId: "g123", accountId: "work" }),
    ).toBe(false);
  });
});
