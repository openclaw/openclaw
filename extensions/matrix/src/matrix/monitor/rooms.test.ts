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

  it("matches room IDs case-insensitively", () => {
    const rooms = {
      "!AbCdEf:Matrix.org": { allow: true, requireMention: false },
    };

    const exact = resolveMatrixRoomConfig({
      rooms,
      roomId: "!AbCdEf:Matrix.org",
      aliases: [],
    });
    expect(exact.allowed).toBe(true);
    expect(exact.config?.requireMention).toBe(false);

    const lowerCase = resolveMatrixRoomConfig({
      rooms,
      roomId: "!abcdef:matrix.org",
      aliases: [],
    });
    expect(lowerCase.allowed).toBe(true);
    expect(lowerCase.config?.requireMention).toBe(false);
    expect(lowerCase.matchSource).toBe("direct");

    const upperCase = resolveMatrixRoomConfig({
      rooms,
      roomId: "!ABCDEF:MATRIX.ORG",
      aliases: [],
    });
    expect(upperCase.allowed).toBe(true);
    expect(upperCase.config?.requireMention).toBe(false);
  });

  it("matches room aliases case-insensitively", () => {
    const rooms = {
      "#MyRoom:example.org": { allow: true, requireMention: false },
    };

    const result = resolveMatrixRoomConfig({
      rooms,
      roomId: "!other:example.org",
      aliases: ["#myroom:example.org"],
    });
    expect(result.allowed).toBe(true);
    expect(result.config?.requireMention).toBe(false);
  });

  it("prefers exact case match over normalized match", () => {
    const rooms = {
      "!room:example.org": { allow: true, requireMention: false },
    };

    const result = resolveMatrixRoomConfig({
      rooms,
      roomId: "!room:example.org",
      aliases: [],
    });
    expect(result.allowed).toBe(true);
    expect(result.matchKey).toBe("!room:example.org");
  });

  it("falls back to wildcard when no case-insensitive match", () => {
    const rooms = {
      "!specific:example.org": { allow: true },
      "*": { allow: true, requireMention: true },
    };

    const result = resolveMatrixRoomConfig({
      rooms,
      roomId: "!unrelated:example.org",
      aliases: [],
    });
    expect(result.allowed).toBe(true);
    expect(result.config?.requireMention).toBe(true);
    expect(result.matchSource).toBe("wildcard");
  });
});
