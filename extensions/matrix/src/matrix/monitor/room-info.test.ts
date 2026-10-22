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
});
