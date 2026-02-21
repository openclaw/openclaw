import { describe, expect, it } from "vitest";
import { resolveMatrixRoomConfig } from "./rooms.js";

describe("resolveMatrixRoomConfig", () => {
  it("returns matchSource=direct for explicit matches, wildcard for * matches", () => {
    const rooms = {
      "!explicit:example.org": { allow: true },
      "*": { allow: false },
    };

    const explicit = resolveMatrixRoomConfig({
      rooms,
      roomId: "!explicit:example.org",
      aliases: [],
      name: null,
    });
    expect(explicit.matchSource).toBe("direct");
    expect(explicit.allowed).toBe(true);

    const wildcard = resolveMatrixRoomConfig({
      rooms,
      roomId: "!other:example.org",
      aliases: [],
      name: null,
    });
    expect(wildcard.matchSource).toBe("wildcard");
    expect(wildcard.allowed).toBe(false);
    expect(wildcard.config).toBeDefined();
  });

  it("matches room IDs and aliases, not names", () => {
    const rooms = {
      "!room:example.org": { allow: true },
      "#alias:example.org": { allow: true },
      "Project Room": { allow: true },
    };

    const byId = resolveMatrixRoomConfig({
      rooms,
      roomId: "!room:example.org",
      aliases: [],
      name: "Project Room",
    });
    expect(byId.allowed).toBe(true);
    expect(byId.matchKey).toBe("!room:example.org");

    const byAlias = resolveMatrixRoomConfig({
      rooms,
      roomId: "!other:example.org",
      aliases: ["#alias:example.org"],
      name: "Other Room",
    });
    expect(byAlias.allowed).toBe(true);
    expect(byAlias.matchKey).toBe("#alias:example.org");

    const byName = resolveMatrixRoomConfig({
      rooms: { "Project Room": { allow: true } },
      roomId: "!different:example.org",
      aliases: [],
      name: "Project Room",
    });
    expect(byName.allowed).toBe(false);
    expect(byName.config).toBeUndefined();
  });
});
