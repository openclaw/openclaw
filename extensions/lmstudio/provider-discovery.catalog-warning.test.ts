import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import lmstudioProviderDiscovery from "./provider-discovery.js";

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, [], [{ type: "embedding", key: "embed-local" }]])(
  "preserves only successful implicit catalog diagnostics: %j",
  async (models) => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(
        vi.fn(async () => {
          if (!models) {
            throw new Error("server offline");
          }
          return Response.json({ models });
        }),
      ),
    );
    const result = await lmstudioProviderDiscovery.catalog.run({
      config: { agents: { defaults: { model: "lmstudio/gemma-typo" } } },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    expect(result).toEqual(
      models
        ? {
            providers: {},
            outcomes: [
              {
                provider: "lmstudio",
                status: "ready",
                modelIdCatalog: {
                  baseUrl: "http://localhost:1234/v1",
                  modelIds: models.length ? ["embed-local"] : [],
                  aliases: [],
                },
              },
            ],
          }
        : null,
    );
  },
);

it.each([false, true])(
  "retains LM Studio listing evidence without configured refs (offline=%s)",
  async (offline) => {
    const fetchMock = vi.fn(async () => {
      if (offline) {
        throw new Error("server offline");
      }
      return Response.json({
        models: [
          {
            type: "llm",
            key: "google/gemma-local",
            selected_variant: "gemma-q4",
            variants: ["gemma-q8"],
            loaded_instances: [{ id: "local-instance" }],
          },
          { type: "embedding", key: "embed-local" },
          { type: "embedding", selected_variant: "orphan-variant" },
        ],
      });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    const ctx: ProviderCatalogContext = {
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://127.0.0.1:1234/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await lmstudioProviderDiscovery.catalog.run(ctx);
    expect(result?.outcomes).toEqual([
      offline
        ? { provider: "lmstudio", status: "unavailable" }
        : {
            provider: "lmstudio",
            status: "ready",
            modelIdCatalog: {
              baseUrl: "http://127.0.0.1:1234/v1",
              modelIds: ["google/gemma-local", "local-instance", "embed-local"],
              aliases: ["gemma-q4", "gemma-q8"],
            },
          },
    ]);
    if (!offline) {
      const catalog = result?.outcomes?.[0]?.modelIdCatalog;
      if (!catalog) {
        throw new Error("successful LM Studio listing omitted evidence");
      }
      expect(
        lmstudioProviderDiscovery.catalog.getUnlistedConfiguredModelIds(catalog, [
          ...[
            "google/gemma-local",
            "lmstudio/google/gemma-local",
            "GEMMA-Q4",
            "gemma-q8",
            "local-instance",
            "embed-local",
            "gemma-typo",
            "LOCAL-INSTANCE",
            "orphan-variant",
          ].map((modelId) => ({ provider: "lmstudio", modelId })),
          {
            provider: "lmstudio",
            modelId: "same-server-typo",
            baseUrl: "127.0.0.1:1234/api/v1/?query=ignored#ignored",
          },
          { provider: "lmstudio", modelId: "other-server", baseUrl: "http://other-server:1234/v1" },
          { provider: "other-provider", modelId: "other-provider-typo" },
        ]),
      ).toEqual(["gemma-typo", "LOCAL-INSTANCE", "orphan-variant", "same-server-typo"]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);
