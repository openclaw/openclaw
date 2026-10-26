import { beforeAll, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import type { ExistingProviderConfig, ProviderModelCatalog } from "./models-config.merge.js";

let merge: typeof import("./models-config.merge.js");
beforeAll(async () => {
  vi.doUnmock("../plugins/manifest-registry.js");
  merge = await import("./models-config.merge.js");
});

const model = (overrides: Partial<ExistingProviderConfig["models"][number]> = {}) =>
  modelDefinition("model", overrides);
const agentUrl = "https://agent.example/v1";
const configUrl = "https://config.example/v1";
type ProviderOverrides = Partial<ExistingProviderConfig>;
const provider = (overrides: ProviderOverrides = {}): ExistingProviderConfig => ({
  baseUrl: configUrl,
  api: "openai-responses",
  apiKey: "CONFIG_KEY",
  models: [model()],
  ...overrides,
});
type Providers = Record<string, ExistingProviderConfig>;
function mergeSecrets(
  nextProviders: Parameters<typeof merge.mergeWithExistingProviderSecrets>[0]["nextProviders"],
  existingProviders: Providers,
) {
  return merge.mergeWithExistingProviderSecrets({
    nextProviders,
    existingProviders,
    secretRefManagedProviders: new Set(),
  });
}
function mergeCustom(next: ProviderOverrides, existing: ProviderOverrides) {
  return mergeSecrets({ custom: provider(next) }, { custom: provider(existing) }).custom;
}

describe("models-config merge", () => {
  it("merges headers and refreshes metadata while preserving authored fields", () => {
    const { input: _input, ...authored } = model({
      reasoning: false,
      cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 2_000_000,
      maxTokens: 200_000,
    });
    const merged = merge.mergeProviderModels<ProviderModelCatalog>(
      { models: [model({ reasoning: true })], headers: { "User-Agent": "catalog" } },
      { models: [authored], headers: { "X-Tenant": "configured" } },
    );
    expect(merged.models).toEqual([{ ...authored, input: ["text"] }]);
    expect(merged.headers).toEqual({ "User-Agent": "catalog", "X-Tenant": "configured" });
  });

  const catalogCompat = { supportsTools: true, supportsTemperature: false };
  const configuredCompat = { supportsTools: false, supportsTemperature: true };
  it.each<[ProviderOverrides, string | undefined, typeof catalogCompat]>([
    [{}, "meta", catalogCompat],
    [{ baseUrl: "http://127.0.0.1:9000/v1" }, undefined, configuredCompat],
    [{ api: "openai-completions" }, undefined, configuredCompat],
    [{ models: [] }, "meta", catalogCompat],
  ])("keeps metadata with its route owner: %j", (overrides, family, compat) => {
    const catalog = provider({ models: [model({ family: "meta", compat: catalogCompat })] });
    const merged = merge.mergeProviderModels(
      catalog,
      provider({ models: [model({ compat: configuredCompat })], ...overrides }),
    );
    expect([merged.models[0]?.family, merged.models[0]?.compat]).toEqual([family, compat]);
    if (overrides.models) {
      expect(merged.models).toEqual(catalog.models);
    }
  });

  it("normalizes providers, retaining valid secrets and dropping invalid stale catalogs", () => {
    const merged = mergeSecrets(merge.mergeProviders({ explicit: { openai: provider() } }), {
      invalid: provider({ baseUrl: undefined }),
      "auth-only": provider({ models: [], apiKey: "AGENT_KEY" }),
      " OpenAI ": provider({ baseUrl: agentUrl, apiKey: "AGENT_KEY" }),
    });
    expect(Object.keys(merged).toSorted()).toEqual(["auth-only", "openai"]);
    expect(merged["auth-only"]?.apiKey).toBe("AGENT_KEY");
    expect(merged.openai).toMatchObject({ apiKey: "AGENT_KEY", baseUrl: agentUrl });
  });

  it("replaces a stale baseUrl when the model API surface changes", () => {
    const merged = mergeCustom(
      { api: undefined, models: [model({ api: "openai-responses" })] },
      {
        baseUrl: agentUrl,
        apiKey: "AGENT_KEY",
        api: undefined,
        models: [model({ api: "openai-completions" })],
      },
    );
    expect(merged).toMatchObject({ apiKey: "AGENT_KEY", baseUrl: configUrl });
  });

  it.each([
    ["plaintext to env marker", "AGENT_KEY", "GOOGLE_API_KEY", agentUrl],
    ["non-env marker to plaintext", NON_ENV_SECRETREF_MARKER, "ALLCAPS_SAMPLE", agentUrl],
    ["empty existing values", "", "CONFIG_KEY", ""],
  ])("uses current credentials for %s", (_name, oldKey, nextKey, oldUrl) => {
    const merged = mergeCustom({ apiKey: nextKey }, { apiKey: oldKey, baseUrl: oldUrl });
    expect(merged).toMatchObject({ apiKey: nextKey, baseUrl: oldUrl || configUrl });
  });
});
