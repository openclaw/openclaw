import { describe, expect, it } from "vitest";
import { resolveMatrixRoomConfig } from "./rooms.js";

describe("resolveMatrixRoomConfig", () => {
  it("matches room IDs and aliases, not names", () => {
    const rooms = {
      "!room:example.org": { enabled: true },
      "#alias:example.org": { enabled: true },
      "Project Room": { enabled: true },
    };

    const byId = resolveMatrixRoomConfig({
      rooms,
      roomId: "!room:example.org",
      aliases: [],
    });
    expect(byId.allowed).toBe(true);
    expect(byId.matchKey).toBe("!room:example.org");
    expect(byId.matchSource).toBe("direct");

    const byAlias = resolveMatrixRoomConfig({
      rooms,
      roomId: "!other:example.org",
      aliases: ["#alias:example.org"],
    });
    expect(byAlias.allowed).toBe(true);
    expect(byAlias.matchKey).toBe("#alias:example.org");
    expect(byAlias.matchSource).toBe("direct");

    const byName = resolveMatrixRoomConfig({
      rooms: { "Project Room": { enabled: true } },
      roomId: "!different:example.org",
      aliases: [],
    });
    expect(byName.allowed).toBe(false);
    expect(byName.config).toBeUndefined();
    expect(byName.matchSource).toBeUndefined();
  });

  describe("matchSource classification", () => {
    it('returns matchSource="wildcard" for wildcard match', () => {
      const result = resolveMatrixRoomConfig({
        rooms: { "*": { enabled: true } },
        roomId: "!any:example.org",
        aliases: [],
      });
      expect(result.matchSource).toBe("wildcard");
      expect(result.config).toEqual({ enabled: true });
    });

    it("direct match takes priority over wildcard", () => {
      const result = resolveMatrixRoomConfig({
        rooms: {
          "!room:example.org": { enabled: true, systemPrompt: "room-specific" },
          "*": { enabled: true, systemPrompt: "generic" },
        },
        roomId: "!room:example.org",
        aliases: [],
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config?.systemPrompt).toBe("room-specific");
    });
  });
});
