import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  createModelVisibilityPolicyWithFallbacks,
} from "./model-selection-shared.js";

afterEach(() => vi.restoreAllMocks());

describe("model selection catalog policy lifetime", () => {
  it.each(["configured", "allowed", "visibility"] as const)(
    "%s preparation reuses provider policies across rows and refreshes them next time",
    (kind) => {
      const loadPolicy = vi.spyOn(providerPolicy, "resolveDirectBundledProviderPolicySurface");
      const select = (rowCount: number, scope: string) => {
        loadPolicy.mockClear().mockReturnValue({
          normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^legacy-/, `${scope}-`),
        });
        const ids = Array.from({ length: rowCount }, (_, index) => `legacy-${index}`);
        const catalog: ModelCatalogEntry[] = ["first", "second"].flatMap((owner) =>
          ids.map((_, index) => ({
            provider: "fixture",
            id: `${owner}-${index}`,
            name: `${owner}-${index}`,
            api: "openai-responses" as const,
            baseUrl: `https://${owner}.example/v1`,
          })),
        );
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { modelPolicy: { allow: ids.map((id) => `fixture/${id}`) } },
          },
        };
        if (kind === "configured") {
          cfg.models = {
            providers: {
              fixture: {
                baseUrl: "https://configured.example/v1",
                models: ids.map((id) => ({
                  id,
                  name: id,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1024,
                })),
              },
            },
          };
        }
        const params = { cfg, catalog, defaultProvider: "fixture", manifestPlugins: [] };
        const selected =
          kind === "configured"
            ? buildConfiguredModelCatalog(params)
            : kind === "allowed"
              ? buildAllowedModelSet(params).allowedCatalog
              : createModelVisibilityPolicyWithFallbacks({
                  ...params,
                  fallbackModels: [],
                  allowManifestNormalization: false,
                  allowPluginNormalization: false,
                }).allowedCatalog;
        expect(selected.map((entry) => entry.baseUrl)).toEqual(
          Array.from({ length: rowCount }, () => `https://${scope}.example/v1`),
        );
        return loadPolicy.mock.calls.length;
      };

      const singleRowLoads = select(1, "first");
      expect(singleRowLoads).toBeGreaterThan(0);
      expect(select(32, "first")).toBe(singleRowLoads);
      expect(select(32, "second")).toBe(singleRowLoads);
    },
  );
});
