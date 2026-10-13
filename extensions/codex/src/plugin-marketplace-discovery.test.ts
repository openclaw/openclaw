import { describe, expect, it, vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import {
  discoverCodexMarketplacePlugins,
  parseCodexPluginMarketplaceId,
} from "./plugin-marketplace-discovery.js";

function catalog(name: string, pluginName: string, path?: string): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name,
        ...(path ? { path } : {}),
        plugins: [
          {
            id: `${pluginName}@${name}`,
            name: pluginName,
            installed: false,
            enabled: false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            interface: {
              displayName: "Security\nReview",
              developerName: "Example\u0000Labs",
              shortDescription: "Summarize\nsource code",
            },
          },
        ],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

describe("Codex marketplace plugin discovery", () => {
  it("preserves authorized workspace catalogs when another supplemental category fails", async () => {
    const request = vi.fn(async (params: v2.PluginListParams) => {
      if (!params.marketplaceKinds) {
        return catalog("openai-curated", "github", "/managed/catalog.json");
      }
      if (params.marketplaceKinds.length > 1) {
        throw new Error("personal catalog requires authentication");
      }
      if (params.marketplaceKinds[0] === "workspace-directory") {
        return catalog("workspace-directory", "security-review");
      }
      throw new Error("catalog not available for this account");
    });

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins.map((plugin) => plugin.id)).toEqual([
      "github@openai-curated",
      "security-review@workspace-directory",
    ]);
    expect(result.warnings).toContain(
      "shared-with-me marketplace unavailable: catalog not available for this account",
    );
  });

  it("fails closed for marketplace and plugin names outside the upstream identifier contract", async () => {
    const request = vi.fn(async () => catalog("../company-tools", "security-review"));

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins).toEqual([]);
    expect(parseCodexPluginMarketplaceId("review@company-tools")).toEqual({
      pluginName: "review",
      marketplaceName: "company-tools",
    });
    expect(parseCodexPluginMarketplaceId("review.v2@company-tools")).toEqual({
      pluginName: "review.v2",
      marketplaceName: "company-tools",
    });
    for (const invalid of [
      "../review@company-tools",
      "review@../company-tools",
      "review@company@tools",
      ".@company-tools",
      "..@company-tools",
      ".review@company-tools",
      "review.@company-tools",
      "review..v2@company-tools",
      "review@company.tools",
    ]) {
      expect(parseCodexPluginMarketplaceId(invalid), invalid).toBeUndefined();
    }
  });

  it("refuses ambiguous equal identifiers from different marketplace paths", async () => {
    const request = vi.fn(async (params: v2.PluginListParams) =>
      params.marketplaceKinds
        ? catalog("company-tools", "security-review", "/different/marketplace.json")
        : catalog("company-tools", "security-review", "/repo/marketplace.json"),
    );

    const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

    expect(result.plugins).toEqual([]);
    expect(result.warnings[0]).toContain("requires a unique identity");
  });

  it.each(["security-review.v2"])(
    "deduplicates qualified and unqualified %s summaries for the same trusted marketplace source",
    async (pluginName) => {
      const request = vi.fn(async (params: v2.PluginListParams) => {
        const listed = catalog("company-tools", pluginName, "/repo/marketplace.json");
        if (!params.marketplaceKinds) {
          listed.marketplaces[0]!.plugins[0]!.id = pluginName;
        }
        return listed;
      });

      const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

      expect(result.plugins.map((plugin) => plugin.id)).toEqual([`${pluginName}@company-tools`]);
      expect(result.warnings).toEqual([]);
    },
  );

  it.each([{ availability: "AVAILABLE", installPolicy: "NOT_AVAILABLE" }] as const)(
    "retains the most restrictive policy across duplicate catalog snapshots",
    async (policy) => {
      const request = vi.fn(async (params: v2.PluginListParams) => {
        const listed = catalog("company-tools", "security-review", "/repo/marketplace.json");
        if (params.marketplaceKinds) {
          Object.assign(listed.marketplaces[0]!.plugins[0]!, policy);
        }
        return listed;
      });

      const result = await discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]?.available).toBe(false);
    },
  );
});
