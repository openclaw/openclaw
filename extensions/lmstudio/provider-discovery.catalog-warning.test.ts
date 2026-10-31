import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import lmstudioProviderDiscovery from "./provider-discovery.js";
import type { LmstudioModelWire } from "./src/models.js";

afterEach(() => vi.unstubAllGlobals());

async function discover(config: ProviderCatalogContext["config"], models?: LmstudioModelWire[]) {
  const fetchMock = vi.fn(async () => {
    if (!models) {
      throw new Error("server offline");
    }
    return Response.json({ models });
  });
  vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
  const result = await lmstudioProviderDiscovery.catalog.run({
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return result;
}

function readyCatalog(baseUrl: string, modelIds: string[], aliases: string[] = []) {
  return { provider: "lmstudio", status: "ready", modelIdCatalog: { baseUrl, modelIds, aliases } };
}

it.each([undefined, [], [{ type: "embedding" as const, key: "embed-local" }]])(
  "preserves only successful implicit catalog diagnostics: %j",
  async (models) => {
    const result = await discover(
      { agents: { defaults: { model: "lmstudio/gemma-typo" } } },
      models,
    );
    const outcome = readyCatalog("http://localhost:1234/v1", models?.length ? ["embed-local"] : []);
    expect(result).toEqual(models ? { providers: {}, outcomes: [outcome] } : null);
  },
);

it.each([false, true])("retains listing evidence (offline=%s)", async (offline) => {
  const models: LmstudioModelWire[] = [
    {
      type: "llm",
      key: "google/gemma-local",
      selected_variant: "gemma-q4",
      variants: ["gemma-q8"],
      loaded_instances: [{ id: "local-instance" }],
    },
    { type: "embedding", key: "embed-local" },
    { type: "embedding", selected_variant: "orphan-variant" },
  ];
  const baseUrl = "http://127.0.0.1:1234/v1";
  const provider = { baseUrl, api: "openai-completions" as const, models: [] };
  const result = await discover(
    { models: { providers: { lmstudio: provider } } },
    offline ? undefined : models,
  );
  expect(result?.outcomes).toEqual([
    offline
      ? { provider: "lmstudio", status: "unavailable" }
      : readyCatalog(
          baseUrl,
          ["google/gemma-local", "local-instance", "embed-local"],
          ["gemma-q4", "gemma-q8"],
        ),
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
});
