import { expect, it } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import {
  discoverCodexMarketplacePlugins,
  parseCodexPluginMarketplaceId,
} from "./plugin-marketplace-discovery.js";

function catalog(name: string, pluginName: string, path?: string): v2.PluginListResponse {
  const plugin: v2.PluginSummary = {
    id: `${pluginName}@${name}`,
    name: pluginName,
    installed: false,
    enabled: false,
  };
  return {
    marketplaces: [{ name, ...(path ? { path } : {}), plugins: [plugin] }],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}
const discover = (request: Parameters<typeof discoverCodexMarketplacePlugins>[0]["request"]) =>
  discoverCodexMarketplacePlugins({ request, workspaceDir: "/repo" });

it("preserves authorized workspace catalogs when another supplemental category fails", async () => {
  const result = await discover(async (params: v2.PluginListParams) => {
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

  expect(result.plugins.map((plugin) => plugin.id)).toEqual([
    "github@openai-curated",
    "security-review@workspace-directory",
  ]);
  expect(result.warnings).toContain(
    "shared-with-me marketplace unavailable: catalog not available for this account",
  );
});

it("fails closed for marketplace and plugin names outside the upstream identifier contract", async () => {
  const result = await discover(async () => catalog("../company-tools", "security-review"));
  expect(result.plugins).toEqual([]);
  for (const pluginName of ["review", "review.v2"]) {
    expect(parseCodexPluginMarketplaceId(`${pluginName}@company-tools`)).toEqual({
      pluginName,
      marketplaceName: "company-tools",
    });
  }
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
  const result = await discover(async (params: v2.PluginListParams) =>
    params.marketplaceKinds
      ? catalog("company-tools", "security-review", "/different/marketplace.json")
      : catalog("company-tools", "security-review", "/repo/marketplace.json"),
  );

  expect(result.plugins).toEqual([]);
  expect(result.warnings[0]).toContain("requires a unique identity");
});

it.each([false, true])(
  "deduplicates a trusted source with restrictive policy: %s",
  async (restricted) => {
    const pluginName = "security-review.v2";
    const result = await discover(async (params: v2.PluginListParams) => {
      const listed = catalog("company-tools", pluginName, "/repo/marketplace.json");
      if (!params.marketplaceKinds) {
        listed.marketplaces[0]!.plugins[0]!.id = pluginName;
      } else if (restricted) {
        Object.assign(listed.marketplaces[0]!.plugins[0]!, {
          availability: "AVAILABLE",
          installPolicy: "NOT_AVAILABLE",
        });
      }
      return listed;
    });
    expect(result.plugins).toMatchObject([
      { id: `${pluginName}@company-tools`, available: !restricted },
    ]);
    expect(result.plugins).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  },
);
