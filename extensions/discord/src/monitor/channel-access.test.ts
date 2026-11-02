// Discord tests cover channel access plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";

function resolveDiscordChannelOwnerIdSafe(channel: unknown) {
  return resolveDiscordChannelInfoSafe(channel).ownerId;
}

describe("resolveDiscordChannelOwnerIdSafe", () => {
  it("prefers camelCase and direct snake_case before rawData", () => {
    expect(
      resolveDiscordChannelOwnerIdSafe({
        ownerId: "camel",
        owner_id: "snake",
        rawData: { owner_id: "raw" },
      }),
    ).toBe("camel");
    expect(
      resolveDiscordChannelOwnerIdSafe({
        owner_id: "snake",
        rawData: { owner_id: "raw" },
      }),
    ).toBe("snake");
  });

  it("ignores invalid values", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ ownerId: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ owner_id: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ rawData: { owner_id: 123 } })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe(null)).toBeUndefined();
  });
});

describe("channel parent aliases", () => {
  it("prefers camelCase over snake_case and rawData", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        parentId: "camel",
        parent_id: "snake",
        rawData: { parent_id: "raw" },
      }).parentId,
    ).toBe("camel");
  });
});

describe("resolveDiscordChannelInfoSafe", () => {
  it("preserves array-backed fields and empty aliases without trimming", () => {
    const channel = Object.assign([], {
      name: " ",
      topic: "",
      ownerId: "",
      owner_id: "fallback",
    });

    expect(resolveDiscordChannelInfoSafe(channel)).toMatchObject({
      name: " ",
      topic: "",
      ownerId: "",
    });
  });

  it("populates ownerId and parentId from Discord API-style snake_case fields", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        owner_id: "owner-snake",
        parent_id: "parent-snake",
      }),
    ).toEqual({
      id: undefined,
      name: undefined,
      topic: undefined,
      type: undefined,
      parentId: "parent-snake",
      ownerId: "owner-snake",
      parentName: undefined,
    });
    expect(
      resolveDiscordChannelInfoSafe({
        rawData: { owner_id: "owner-raw", parent_id: "parent-raw" },
      }),
    ).toEqual({
      id: undefined,
      name: undefined,
      topic: undefined,
      type: undefined,
      parentId: "parent-raw",
      ownerId: "owner-raw",
      parentName: undefined,
    });
  });
});
