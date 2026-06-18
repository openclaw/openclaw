import { describe, expect, it } from "vitest";
import {
  ARD_MEDIA_TYPE_MCP_SERVER_CARD,
  ARD_MEDIA_TYPE_MCP_SERVER_LEGACY,
  parseArdIdentifier,
  validateArdCatalogEntry,
  validateArdCatalogManifest,
  validateArdSearchRequest,
} from "./index.js";

describe("ard-core validation", () => {
  it("validates and normalizes ARD catalog manifests", () => {
    const result = validateArdCatalogManifest({
      specVersion: "1.0",
      host: {
        displayName: "OpenClaw",
        federation: "auto",
        url: "https://example.test",
      },
      entries: [
        {
          identifier: "urn:ai:openclaw:plugins:github",
          displayName: "GitHub",
          type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
          url: "https://example.test/github/card.json",
          tags: [" code ", " review "],
          capabilities: ["pull-requests"],
          representativeQueries: ["review this PR", "fix failing CI"],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      value: {
        specVersion: "1.0",
        entries: [
          {
            identifier: "urn:ai:openclaw:plugins:github",
            displayName: "GitHub",
            type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
            tags: ["code", "review"],
          },
        ],
      },
    });
  });

  it("rejects invalid identifiers and ambiguous resource locations", () => {
    const result = validateArdCatalogEntry({
      identifier: "github",
      displayName: "GitHub",
      type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
      url: "https://example.test/card.json",
      data: {},
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "identifier must be a valid urn:ai:<publisher>:<namespace>:<name> value",
        "entry must define exactly one of url or data",
      ]),
    );
  });

  it("accepts legacy MCP server media type with a warning", () => {
    const result = validateArdCatalogEntry({
      identifier: "urn:ai:openclaw:mcp:filesystem",
      displayName: "Filesystem",
      type: ARD_MEDIA_TYPE_MCP_SERVER_LEGACY,
      data: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      representativeQueries: ["read a file"],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("type uses legacy application/mcp-server+json spelling");
    expect(result.warnings).toContain("representativeQueries should contain 2 to 5 entries");
  });

  it("parses urn:ai identifiers", () => {
    expect(parseArdIdentifier("urn:ai:openclaw:plugins:github")).toEqual({
      publisher: "openclaw",
      segments: ["plugins", "github"],
      name: "github",
    });
    expect(parseArdIdentifier("urn:ai:bad space:github")).toBeNull();
  });

  it("validates search requests and clamps page size", () => {
    const result = validateArdSearchRequest({
      query: "ci",
      filters: {
        publisher: "openclaw",
        type: [ARD_MEDIA_TYPE_MCP_SERVER_CARD],
      },
      pageSize: 500,
      pageToken: "2",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        query: "ci",
        filters: {
          publisher: "openclaw",
          type: [ARD_MEDIA_TYPE_MCP_SERVER_CARD],
        },
        pageSize: 100,
        pageToken: "2",
      },
      warnings: [],
    });
  });
});
