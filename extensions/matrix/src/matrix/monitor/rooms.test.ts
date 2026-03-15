import { describe, expect, it } from "vitest";
import { resolveMatrixRoomConfig } from "./rooms.js";

describe("resolveMatrixRoomConfig", () => {
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

  describe("matchSource classification", () => {
    it('returns matchSource="direct" for exact room ID match', () => {
      const result = resolveMatrixRoomConfig({
        rooms: { "!room:example.org": { allow: true } },
        roomId: "!room:example.org",
        aliases: [],
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config).toBeDefined();
    });

    it('returns matchSource="direct" for alias match', () => {
      const result = resolveMatrixRoomConfig({
        rooms: { "#alias:example.org": { allow: true } },
        roomId: "!room:example.org",
        aliases: ["#alias:example.org"],
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config).toBeDefined();
    });

    it('returns matchSource="wildcard" for wildcard match', () => {
      const result = resolveMatrixRoomConfig({
        rooms: { "*": { allow: true } },
        roomId: "!any:example.org",
        aliases: [],
      });
      expect(result.matchSource).toBe("wildcard");
      expect(result.config).toBeDefined();
    });

    it("returns undefined matchSource when no match", () => {
      const result = resolveMatrixRoomConfig({
        rooms: { "!other:example.org": { allow: true } },
        roomId: "!room:example.org",
        aliases: [],
      });
      expect(result.matchSource).toBeUndefined();
      expect(result.config).toBeUndefined();
    });

    it("direct match takes priority over wildcard", () => {
      const result = resolveMatrixRoomConfig({
        rooms: {
          "!room:example.org": { allow: true, systemPrompt: "room-specific" },
          "*": { allow: true, systemPrompt: "generic" },
        },
        roomId: "!room:example.org",
        aliases: [],
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config?.systemPrompt).toBe("room-specific");
    });
  });

  describe("DM override safety (matchSource distinction)", () => {
    // These tests verify the matchSource property that handler.ts uses
    // to decide whether a configured room should override DM classification.
    // Only "direct" matches should trigger the override -- never "wildcard".

    it("wildcard config should NOT be usable to override DM classification", () => {
      const result = resolveMatrixRoomConfig({
        rooms: { "*": { allow: true, skills: ["general"] } },
        roomId: "!dm-room:example.org",
        aliases: [],
      });
      // handler.ts checks: matchSource === "direct" -> this is "wildcard", so no override
      expect(result.matchSource).not.toBe("direct");
      expect(result.matchSource).toBe("wildcard");
    });

    it("explicitly configured room should be usable to override DM classification", () => {
      const result = resolveMatrixRoomConfig({
        rooms: {
          "!configured-room:example.org": { allow: true },
          "*": { allow: true },
        },
        roomId: "!configured-room:example.org",
        aliases: [],
      });
      // handler.ts checks: matchSource === "direct" -> this IS "direct", so override is safe
      expect(result.matchSource).toBe("direct");
    });
  });
});
