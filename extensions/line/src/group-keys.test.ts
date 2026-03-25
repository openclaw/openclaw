import { describe, expect, it } from "vitest";
import {
  resolveExactLineGroupConfigKey,
  resolveLineGroupConfigEntry,
  resolveLineGroupHistoryKey,
  resolveLineGroupLookupIds,
  resolveLineGroupsConfig,
} from "./group-keys.js";

describe("resolveLineGroupLookupIds", () => {
  it("expands raw ids to both prefixed candidates", () => {
    expect(resolveLineGroupLookupIds("abc123")).toEqual(["abc123", "group:abc123", "room:abc123"]);
  });

  it("preserves prefixed ids while also checking the raw id", () => {
    expect(resolveLineGroupLookupIds("room:abc123")).toEqual(["abc123", "room:abc123"]);
    expect(resolveLineGroupLookupIds("group:abc123")).toEqual(["abc123", "group:abc123"]);
  });
});

describe("resolveLineGroupConfigEntry", () => {
  it("matches raw, prefixed, and wildcard group config entries", () => {
    const groups = {
      "group:g1": { requireMention: false },
      "room:r1": { systemPrompt: "Room prompt" },
      "*": { requireMention: true },
    };

    expect(resolveLineGroupConfigEntry(groups, { groupId: "g1" })).toEqual({
      requireMention: false,
    });
    expect(resolveLineGroupConfigEntry(groups, { roomId: "r1" })).toEqual({
      systemPrompt: "Room prompt",
    });
    expect(resolveLineGroupConfigEntry(groups, { groupId: "missing" })).toEqual({
      requireMention: true,
    });
  });
});

describe("resolveLineGroupHistoryKey", () => {
  it("uses the raw group or room id as the shared LINE peer key", () => {
    expect(resolveLineGroupHistoryKey({ groupId: "g1" })).toBe("g1");
    expect(resolveLineGroupHistoryKey({ roomId: "r1" })).toBe("r1");
    expect(resolveLineGroupHistoryKey({})).toBeUndefined();
  });
});

describe("account-scoped LINE groups", () => {
  it("resolves the effective account-scoped groups map", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            "*": { requireMention: true },
          },
          accounts: {
            work: {
              groups: {
                "group:g1": { requireMention: false },
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveLineGroupsConfig(cfg, "work")).toEqual({
      "group:g1": { requireMention: false },
    });
    expect(resolveExactLineGroupConfigKey({ cfg, accountId: "work", groupId: "g1" })).toBe(
      "group:g1",
    );
    expect(resolveExactLineGroupConfigKey({ cfg, accountId: "default", groupId: "g1" })).toBe(
      undefined,
    );
  });
});
