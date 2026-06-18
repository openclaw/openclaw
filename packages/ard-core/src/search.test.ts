import { describe, expect, it } from "vitest";
import { ARD_MEDIA_TYPE_MCP_SERVER_CARD, searchArdCatalogEntries } from "./index.js";
import type { ArdCatalogEntry } from "./index.js";

const entries: ArdCatalogEntry[] = [
  {
    identifier: "urn:ai:openclaw:plugins:github",
    displayName: "GitHub",
    type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
    url: "https://example.test/github/card.json",
    tags: ["code", "review"],
    capabilities: ["pull requests", "ci"],
    representativeQueries: ["review this PR", "fix failing CI"],
  },
  {
    identifier: "urn:ai:openclaw:plugins:calendar",
    displayName: "Calendar",
    type: "application/vnd.openclaw.plugin+json",
    data: { id: "calendar" },
    tags: ["productivity"],
    capabilities: ["events"],
  },
  {
    identifier: "urn:ai:external:agents:ci-monitor",
    displayName: "CI Monitor",
    type: "application/a2a-agent-card+json",
    url: "https://example.test/ci/card.json",
    tags: ["ci"],
    capabilities: ["pipeline status"],
  },
];

describe("ard-core search", () => {
  it("scores matching entries and returns stable relevance order", () => {
    const result = searchArdCatalogEntries(entries, { query: "fix ci" }, "local");

    expect(
      result.results.map((entry) => [entry.entry.identifier, entry.score, entry.source]),
    ).toEqual([
      ["urn:ai:external:agents:ci-monitor", 46, "local"],
      ["urn:ai:openclaw:plugins:github", 39, "local"],
    ]);
  });

  it("filters by derived publisher and nested fields", () => {
    const result = searchArdCatalogEntries(entries, {
      filters: {
        publisher: "openclaw",
        type: ARD_MEDIA_TYPE_MCP_SERVER_CARD,
      },
    });

    expect(result.results.map((entry) => entry.entry.displayName)).toEqual(["GitHub"]);
  });

  it("paginates local results with numeric page tokens", () => {
    const firstPage = searchArdCatalogEntries(entries, { pageSize: 2 });
    const secondPage = searchArdCatalogEntries(entries, {
      pageSize: 2,
      pageToken: firstPage.nextPageToken,
    });

    expect(firstPage.nextPageToken).toBe("2");
    expect(firstPage.results).toHaveLength(2);
    expect(secondPage.results).toHaveLength(1);
    expect(secondPage.nextPageToken).toBeUndefined();
  });
});
