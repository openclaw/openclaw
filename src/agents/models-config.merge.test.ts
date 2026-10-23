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
  it("refreshes metadata while preserving explicit reasoning overrides", () => {
    const { input: _input, ...authored } = model({
      reasoning: false,
      cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 2_000_000,
      maxTokens: 200_000,
    });
    const catalog = { models: [model({ reasoning: true })] };
    const merged = merge.mergeProviderModels(catalog, { models: [authored] });
    expect(merged.models).toEqual([{ ...authored, input: ["text"] }]);
  });

  it("uses compat from the owner of the configured local route", () => {
    const merged = merge.mergeProviderModels(
      provider({
        baseUrl: "https://catalog.example/v1/",
        models: [model({ compat: { supportsTools: true, supportsTemperature: false } })],
      }),
      provider({
        baseUrl: "http://127.0.0.1:9000/v1",
        models: [model({ compat: { supportsTools: false, supportsTemperature: true } })],
      }),
    );
    expect(merged.models[0]?.compat).toEqual({ supportsTools: false, supportsTemperature: true });
  });

  it("drops invalid stale catalogs while retaining auth-only providers", () => {
    const merged = mergeSecrets(
      { openai: provider() },
      {
        invalid: provider({ baseUrl: undefined }),
        "auth-only": provider({ models: [], apiKey: "AGENT_KEY" }),
      },
    );
    expect(merged.invalid).toBeUndefined();
    expect(merged["auth-only"]?.apiKey).toBe("AGENT_KEY");
    expect(merged.openai).toBeDefined();
  });

  it("preserves existing secrets after provider key normalization", () => {
    const merged = mergeSecrets(merge.mergeProviders({ explicit: { openai: provider() } }), {
      " OpenAI ": provider({ baseUrl: agentUrl, apiKey: "AGENT_KEY" }),
    });
    expect(Object.keys(merged)).toEqual(["openai"]);
    expect(merged.openai).toMatchObject({ apiKey: "AGENT_KEY", baseUrl: agentUrl });
  });

  it("merges implicit and explicit provider headers", () => {
    const catalog = {
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      models: [{ id: "model" }],
    };
    const merged = merge.mergeProviderModels<ProviderModelCatalog>(
      { ...catalog, headers: { "User-Agent": "claude-code/0.1.0" } },
      { ...catalog, headers: { "X-Kimi-Tenant": "tenant-a" } },
    );
    expect(merged).toEqual({
      ...catalog,
      headers: { "User-Agent": "claude-code/0.1.0", "X-Kimi-Tenant": "tenant-a" },
    });
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
