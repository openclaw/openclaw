import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { ollamaProviderDiscovery } from "./provider-discovery.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["listed", "empty", "offline"] as const)(
  "retains Ollama listing evidence without configured refs (%s)",
  async (inventory) => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (inventory === "offline") {
        throw new Error("server offline");
      }
      return Response.json(
        String(input).endsWith("/api/tags")
          ? {
              models:
                inventory === "empty"
                  ? []
                  : [
                      { name: "llama3.2:latest" },
                      { name: "qwen3:8b" },
                      { name: "nomic-embed-text:latest" },
                    ],
            }
          : { capabilities: ["completion"], model_info: {} },
      );
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    const ctx: ProviderCatalogContext = {
      config: {
        models: {
          providers: { ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama", models: [] } },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await ollamaProviderDiscovery.catalog.run(ctx);
    expect(result?.outcomes).toEqual([
      inventory === "offline"
        ? { provider: "ollama", status: "unavailable" }
        : {
            provider: "ollama",
            status: "ready",
            modelIdCatalog: {
              baseUrl: "http://127.0.0.1:11434",
              modelIds:
                inventory === "empty"
                  ? []
                  : ["llama3.2:latest", "qwen3:8b", "nomic-embed-text:latest"],
            },
          },
    ]);
    if (inventory !== "offline") {
      const catalog = result?.outcomes?.[0]?.modelIdCatalog;
      if (!catalog) {
        throw new Error("successful Ollama listing omitted evidence");
      }
      expect(
        ollamaProviderDiscovery.catalog.getUnlistedConfiguredModelIds(catalog, [
          ...[
            "llama3.2",
            "ollama/llama3.2",
            "LLAMA3.2:latest",
            "qwen3:8b",
            "qwen3:8bb",
            "nomic-embed-text",
          ].map((modelId) => ({ provider: "ollama", modelId })),
          {
            provider: "ollama",
            modelId: "same-server-typo",
            baseUrl: "http://127.0.0.1:11434/V1/",
          },
          { provider: "ollama", modelId: "other-server", baseUrl: "http://other-server:11434" },
          { provider: "other-provider", modelId: "other-provider-typo" },
        ]),
      ).toEqual(
        inventory === "empty"
          ? [
              "llama3.2",
              "ollama/llama3.2",
              "LLAMA3.2:latest",
              "qwen3:8b",
              "qwen3:8bb",
              "nomic-embed-text",
              "same-server-typo",
            ]
          : ["qwen3:8bb", "same-server-typo"],
      );
    }
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/tags")),
    ).toHaveLength(1);
  },
);
