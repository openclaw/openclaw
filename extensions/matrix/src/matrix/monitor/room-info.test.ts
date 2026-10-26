import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";

const room = "!room:example.org";
const alice = "@alice:example.org";
const bob = "@bob:example.org";
const metadata = {
  name: "Room",
  canonicalAlias: "#room:example.org",
  altAliases: ["#alt:example.org"],
  nameResolved: true,
  aliasesResolved: true,
};

function setup(
  handler: (roomId: string, type: string, key: string) => Promise<Record<string, unknown>>,
) {
  const lookup = vi.fn(handler);
  const resolver = createMatrixRoomInfoResolver({
    getRoomStateEvent: lookup,
  } as unknown as MatrixClient);
  return {
    lookup,
    info: (includeAliases?: true) =>
      resolver.getRoomInfo(room, includeAliases ? { includeAliases } : undefined),
    member: (user = alice) => resolver.getMemberDisplayName(room, user),
    invalidate: (user: string) => resolver.invalidateMemberDisplayName(room, user),
  };
}

describe("createMatrixRoomInfoResolver", () => {
  it("caches room names and member display names, and loads aliases only on demand", async () => {
    const f = setup(async (_room, type) => {
      if (type === "m.room.name") {
        return { name: metadata.name };
      }
      if (type === "m.room.canonical_alias") {
        return { alias: metadata.canonicalAlias, alt_aliases: metadata.altAliases };
      }
      return type === "m.room.member" ? { displayname: "Alice" } : {};
    });
    await expect(f.info()).resolves.toEqual({
      name: "Room",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: false,
    });
    await f.info();
    await expect(f.info(true)).resolves.toEqual(metadata);
    await f.info(true);
    await f.member();
    await f.member();
    expect(f.lookup).toHaveBeenCalledTimes(3);
  });

  it("caches fallback user IDs when member display names are missing", async () => {
    const f = setup(async () => ({}));
    await expect(f.member()).resolves.toBe(alice);
    await expect(f.member()).resolves.toBe(alice);
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });

  it("treats missing room metadata as resolved-empty state", async () => {
    const f = setup(async (_room, type) => {
      if (type === "m.room.name" || type === "m.room.canonical_alias") {
        throw Object.assign(new Error("M_NOT_FOUND"), {
          statusCode: 404,
          body: { errcode: "M_NOT_FOUND" },
        });
      }
      return {};
    });
    await expect(f.info(true)).resolves.toEqual({
      altAliases: [],
      aliasesResolved: true,
      nameResolved: true,
    });
  });

  it("retries room metadata after a transient lookup failure", async () => {
    const f = setup(async (_room, type) => {
      if (type !== "m.room.name" && type !== "m.room.canonical_alias") {
        return {};
      }
      if (f.lookup.mock.calls.filter(([, calledType]) => calledType === type).length === 1) {
        throw new Error("metadata lookup unavailable");
      }
      return type === "m.room.name"
        ? { name: metadata.name }
        : { alias: metadata.canonicalAlias, alt_aliases: metadata.altAliases };
    });
    await expect(f.info(true)).resolves.toEqual({
      altAliases: [],
      aliasesResolved: false,
      nameResolved: false,
    });
    await expect(f.info(true)).resolves.toEqual(metadata);
  });

  it("retries member display names after transient state lookup failures", async () => {
    const f = setup(async () => ({ displayname: "Recovered Alice" }));
    f.lookup.mockRejectedValueOnce(new Error("member lookup failed"));
    await expect(f.member()).resolves.toBe(alice);
    await expect(f.member()).resolves.toBe("Recovered Alice");
    expect(f.lookup).toHaveBeenCalledTimes(2);
  });

  it("refreshes only the observed member after a room membership state change", async () => {
    let name = "Original Alice";
    const f = setup(async (_room, _type, key) => ({ displayname: key === alice ? name : "Bob" }));
    await expect(f.member()).resolves.toBe("Original Alice");
    await f.member(bob);
    name = "Renamed Alice";
    f.invalidate(alice);
    await expect(f.member()).resolves.toBe("Renamed Alice");
    await expect(f.member(bob)).resolves.toBe("Bob");
    expect(f.lookup).toHaveBeenCalledTimes(3);
  });

  it("serves the current name of a renamed room only when asked for it", async () => {
    let roomName = "Original Room";
    const lookup = vi.fn(async (roomId: string, eventType: string) => {
      if (eventType === "m.room.name") {
        return { name: roomId === "!room:example.org" ? roomName : "Other Room" };
      }
      return { alias: "#room:example.org" };
    });
    const resolver = createMatrixRoomInfoResolver({
      getRoomStateEvent: lookup,
    } as unknown as MatrixClient);

    await resolver.getRoomInfo("!room:example.org", { includeAliases: true });
    await resolver.getRoomInfo("!other:example.org");

    roomName = "Renamed Room";
    resolver.invalidateRoomName("!room:example.org");

    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true, currentName: true }),
    ).resolves.toMatchObject({ name: "Renamed Room", canonicalAlias: "#room:example.org" });
    // Without currentName (the lookup DM promotion uses) the first resolved name is kept.
    await expect(
      resolver.getRoomInfo("!room:example.org", { includeAliases: true }),
    ).resolves.toMatchObject({ name: "Original Room", canonicalAlias: "#room:example.org" });
    await expect(
      resolver.getRoomInfo("!other:example.org", { currentName: true }),
    ).resolves.toMatchObject({ name: "Other Room" });
    expect(lookup.mock.calls.filter(([, type]) => type === "m.room.name")).toHaveLength(3);
    expect(lookup.mock.calls.filter(([, type]) => type === "m.room.canonical_alias")).toHaveLength(
      1,
    );

    roomName = "Recovered Room";
    resolver.invalidateRoomName(room);
    lookup.mockRejectedValueOnce(new Error("room name lookup unavailable"));
    await expect(resolver.getRoomInfo(room, { currentName: true })).resolves.toMatchObject({
      name: undefined,
      nameResolved: false,
    });
    await expect(resolver.getRoomInfo(room, { currentName: true })).resolves.toMatchObject({
      name: "Recovered Room",
      nameResolved: true,
    });
    await expect(resolver.getRoomInfo(room)).resolves.toMatchObject({ name: "Original Room" });
  });
});
