import { describe, expect, it } from "vitest";
import {
  ARD_MEDIA_TYPE_MCP_SERVER_CARD,
  ARD_MEDIA_TYPE_MCP_SERVER_LEGACY,
  parseArdIdentifier,
  validateArdCatalogEntry,
  validateArdCatalogManifest,
  validateArdSearchRequest,
} from "./index.js";

describe("ard plugin validation", () => {
  it("validates and normalizes ARD catalog manifests", () => {
    const result = validateArdCatalogManifest({
      specVersion: "1.0",
      host: {
        displayName: "OpenClaw",
        identifier: "did:web:openclaw.dev",
        documentationUrl: "https://openclaw.dev/docs",
        logoUrl: "https://openclaw.dev/logo.png",
      },
      entries: [
        {
          identifier: "urn:air:openclaw.dev:plugins:github",
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
            identifier: "urn:air:openclaw.dev:plugins:github",
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
        "identifier must be a valid urn:air:<publisher-fqdn>:<namespace>:<name> value",
        "entry must define exactly one of url or data",
      ]),
    );
  });

  it("rejects non-domain ARD publishers", () => {
    const result = validateArdCatalogEntry({
      identifier: "urn:air:openclaw:plugins:github",
      displayName: "GitHub",
      type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
      url: "https://example.test/card.json",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "identifier must be a valid urn:air:<publisher-fqdn>:<namespace>:<name> value",
    );
  });

  it("accepts legacy MCP server media type with a warning", () => {
    const result = validateArdCatalogEntry({
      identifier: "urn:air:openclaw.dev:mcp:filesystem",
      displayName: "Filesystem",
      type: ARD_MEDIA_TYPE_MCP_SERVER_LEGACY,
      data: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      representativeQueries: ["read a file"],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("type uses legacy application/mcp-server+json spelling");
    expect(result.warnings).toContain("representativeQueries should contain 2 to 5 entries");
  });

  it("parses urn:air identifiers with FQDN publishers", () => {
    expect(parseArdIdentifier("urn:air:openclaw.dev:plugins:github")).toEqual({
      publisher: "openclaw.dev",
      segments: ["plugins", "github"],
      name: "github",
    });
    expect(parseArdIdentifier("urn:air:bad space:github")).toBeNull();
    expect(parseArdIdentifier("urn:ai:openclaw.dev:plugins:github")).toBeNull();
    expect(parseArdIdentifier("urn:air:openclaw:plugins:github")).toBeNull();
  });

  it("preserves upstream ARD trust manifest objects", () => {
    const result = validateArdCatalogEntry({
      identifier: "urn:air:acme.com:agents:assistant",
      displayName: "Acme Assistant",
      type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
      url: "https://acme.com/agents/assistant.json",
      trustManifest: {
        identity: "spiffe://acme.com/agents/assistant",
        identityType: "spiffe",
        trustSchema: {
          identifier: "urn:acme:trust:schema",
          version: "2026-06",
          governanceUri: "https://trust.acme.com/governance",
          verificationMethods: ["dns-01", "x509"],
        },
        attestations: [
          {
            type: "SOC2-Type2",
            uri: "https://trust.acme.com/reports/soc2.pdf",
            mediaType: "application/pdf",
            digest: "sha256:abc123",
          },
        ],
        provenance: [
          {
            relation: "publishedFrom",
            sourceId: "urn:air:acme.com:catalog:source",
            sourceDigest: "sha256:def456",
          },
        ],
        signature: "eyJhbGciOiJFUzI1NiJ9.signature",
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        identifier: "urn:air:acme.com:agents:assistant",
        displayName: "Acme Assistant",
        type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
        url: "https://acme.com/agents/assistant.json",
        trustManifest: {
          identity: "spiffe://acme.com/agents/assistant",
          identityType: "spiffe",
          trustSchema: {
            identifier: "urn:acme:trust:schema",
            version: "2026-06",
            governanceUri: "https://trust.acme.com/governance",
            verificationMethods: ["dns-01", "x509"],
          },
          attestations: [
            {
              type: "SOC2-Type2",
              uri: "https://trust.acme.com/reports/soc2.pdf",
              mediaType: "application/pdf",
              digest: "sha256:abc123",
            },
          ],
          provenance: [
            {
              relation: "publishedFrom",
              sourceId: "urn:air:acme.com:catalog:source",
              sourceDigest: "sha256:def456",
            },
          ],
          signature: "eyJhbGciOiJFUzI1NiJ9.signature",
        },
      },
      warnings: [],
    });
  });

  it("requires trust manifest identity and attestation objects", () => {
    const result = validateArdCatalogEntry({
      identifier: "urn:air:acme.com:agents:assistant",
      displayName: "Acme Assistant",
      type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
      url: "https://acme.com/agents/assistant.json",
      trustManifest: {
        attestations: ["https://trust.acme.com/reports/soc2.pdf"],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "trustManifest.identity must be a non-empty string",
        "trustManifest.attestations[0] must be an object",
      ]),
    );
  });

  it("validates search requests and clamps page size", () => {
    const result = validateArdSearchRequest({
      query: "ci",
      filters: {
        publisher: "openclaw.dev",
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
          publisher: "openclaw.dev",
          type: [ARD_MEDIA_TYPE_MCP_SERVER_CARD],
        },
        pageSize: 100,
        pageToken: "2",
      },
      warnings: [],
    });
  });
});
