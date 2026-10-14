// Discord tests cover channel access plugin behavior.
import { describe, expect, it } from "vitest";
import {
  resolveDiscordChannelInfoSafe,
  resolveDiscordChannelParentIdSafe,
} from "./channel-access.js";

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

  it("ignores invalid values and unsafe accessors", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ ownerId: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ owner_id: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ rawData: { owner_id: 123 } })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe(null)).toBeUndefined();
    expect(
      resolveDiscordChannelOwnerIdSafe(
        new Proxy(
          {},
          {
            get() {
              throw new Error("boom");
            },
            has() {
              throw new Error("boom");
            },
          },
        ),
      ),
    ).toBeUndefined();
  });
});

describe("resolveDiscordChannelParentIdSafe", () => {
  it("prefers camelCase over snake_case and rawData", () => {
    expect(
      resolveDiscordChannelParentIdSafe({
        parentId: "camel",
        parent_id: "snake",
        rawData: { parent_id: "raw" },
      }),
    ).toBe("camel");
  });
});

describe("resolveDiscordChannelInfoSafe", () => {
  it("populates ownerId and parentId from Discord API-style snake_case fields", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        owner_id: "owner-snake",
        parent_id: "parent-snake",
      }),
    ).toEqual({
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
      name: undefined,
      topic: undefined,
      type: undefined,
      parentId: "parent-raw",
      ownerId: "owner-raw",
      parentName: undefined,
    });
  });
});
