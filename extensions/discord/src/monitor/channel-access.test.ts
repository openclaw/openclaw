import { describe, expect, it } from "vitest";
import {
  resolveDiscordChannelInfoSafe,
  resolveDiscordChannelOwnerIdSafe,
  resolveDiscordChannelParentIdSafe,
} from "./channel-access.js";

describe("resolveDiscordChannelOwnerIdSafe", () => {
  it("reads camelCase ownerId directly", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ ownerId: "owner-1" })).toBe("owner-1");
  });

  it("falls back to direct snake_case owner_id", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ owner_id: "owner-2" })).toBe("owner-2");
  });

  it("falls back to rawData.owner_id when direct properties are missing", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ rawData: { owner_id: "owner-3" } })).toBe("owner-3");
  });

  it("prefers camelCase over snake_case and rawData", () => {
    expect(
      resolveDiscordChannelOwnerIdSafe({
        ownerId: "camel",
        owner_id: "snake",
        rawData: { owner_id: "raw" },
      }),
    ).toBe("camel");
  });

  it("prefers direct snake_case over rawData", () => {
    expect(
      resolveDiscordChannelOwnerIdSafe({
        owner_id: "snake",
        rawData: { owner_id: "raw" },
      }),
    ).toBe("snake");
  });

  it("ignores non-string values from any source", () => {
    expect(resolveDiscordChannelOwnerIdSafe({ ownerId: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ owner_id: 123 })).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe({ rawData: { owner_id: 123 } })).toBeUndefined();
  });

  it("returns undefined for unknown / non-object inputs", () => {
    expect(resolveDiscordChannelOwnerIdSafe(undefined)).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe(null)).toBeUndefined();
    expect(resolveDiscordChannelOwnerIdSafe(42)).toBeUndefined();
  });

  it("does not throw when accessors throw", () => {
    const channel = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
      },
    );

    expect(() => resolveDiscordChannelOwnerIdSafe(channel)).not.toThrow();
    expect(resolveDiscordChannelOwnerIdSafe(channel)).toBeUndefined();
  });
});

describe("resolveDiscordChannelParentIdSafe", () => {
  it("reads camelCase parentId directly", () => {
    expect(resolveDiscordChannelParentIdSafe({ parentId: "parent-1" })).toBe("parent-1");
  });

  it("falls back to direct snake_case parent_id", () => {
    expect(resolveDiscordChannelParentIdSafe({ parent_id: "parent-2" })).toBe("parent-2");
  });

  it("falls back to rawData.parent_id when direct properties are missing", () => {
    expect(resolveDiscordChannelParentIdSafe({ rawData: { parent_id: "parent-3" } })).toBe(
      "parent-3",
    );
  });

  it("prefers camelCase over snake_case and rawData", () => {
    expect(
      resolveDiscordChannelParentIdSafe({
        parentId: "camel",
        parent_id: "snake",
        rawData: { parent_id: "raw" },
      }),
    ).toBe("camel");
  });

  it("ignores non-string fallback values", () => {
    expect(resolveDiscordChannelParentIdSafe({ parent_id: 7 })).toBeUndefined();
    expect(resolveDiscordChannelParentIdSafe({ rawData: { parent_id: 7 } })).toBeUndefined();
  });
});

describe("resolveDiscordChannelInfoSafe", () => {
  it("populates ownerId and parentId from camelCase fields", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        ownerId: "owner-camel",
        parentId: "parent-camel",
      }),
    ).toMatchObject({ ownerId: "owner-camel", parentId: "parent-camel" });
  });

  it("populates ownerId and parentId from direct snake_case fields", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        owner_id: "owner-snake",
        parent_id: "parent-snake",
      }),
    ).toMatchObject({ ownerId: "owner-snake", parentId: "parent-snake" });
  });

  it("populates ownerId and parentId from rawData snake_case fields", () => {
    expect(
      resolveDiscordChannelInfoSafe({
        rawData: { owner_id: "owner-raw", parent_id: "parent-raw" },
      }),
    ).toMatchObject({ ownerId: "owner-raw", parentId: "parent-raw" });
  });
});
