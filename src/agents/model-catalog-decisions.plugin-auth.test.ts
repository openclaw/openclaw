import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  mockRouteResolverFactory,
  routeResolverFactory,
} from "./model-auth-availability.test-support.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import {
  authStore,
  harnessRegistry,
  oauth,
  row as model,
  snapshot as catalogSnapshot,
} from "./model-catalog-fixtures.test-support.js";

describe("catalog plugin OAuth refresh", () => {
  it.each([
    ["owns OAuth refresh", true],
    ["does not own OAuth refresh", false],
  ] as const)(
    "keeps an expired plugin OAuth model available only when its loaded plugin %s",
    (_label, ownsRefresh) => {
      mockRouteResolverFactory(routeResolverFactory(null));
      const acme = model("acme", "acme-pro");
      const pluginRegistry = harnessRegistry("codex");
      pluginRegistry.providers.push({
        pluginId: "acme",
        source: "fixture",
        provider: {
          id: "acme",
          label: "Acme",
          auth: [],
          ...(ownsRefresh ? { refreshOAuth: async (credential) => credential } : {}),
        },
      } as (typeof pluginRegistry.providers)[number]);
      const prepared = createModelCatalogDecisions({
        cfg: {},
        agentId: "main",
        workspaceDir: "/tmp/catalog-workspace",
        snapshot: catalogSnapshot([acme]),
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "acme", providers: ["acme"] }],
        }),
        pluginRegistry,
        preparedAuthStore: authStore({ "acme:user": oauth("acme", Date.now() - 60_000) }),
      });

      const evaluation = prepared.evaluateEntry(acme);
      if (ownsRefresh) {
        expect(evaluation).toMatchObject({ availability: true });
      } else {
        expect(evaluation.availability).not.toBe(true);
      }
    },
  );
});
