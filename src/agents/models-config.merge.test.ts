import { beforeAll, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import type { ExistingProviderConfig, ProviderModelCatalog } from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

let mergeProviderModels: typeof import("./models-config.merge.js").mergeProviderModels;
let mergeProviders: typeof import("./models-config.merge.js").mergeProviders;
let mergeWithExistingProviderSecrets: typeof import("./models-config.merge.js").mergeWithExistingProviderSecrets;
beforeAll(async () => {
  vi.doUnmock("../plugins/manifest-registry.js");
  ({ mergeProviderModels, mergeProviders, mergeWithExistingProviderSecrets } =
    await import("./models-config.merge.js"));
});

const model = (
  overrides: Partial<ProviderConfig["models"][number]> = {},
): ProviderConfig["models"][number] =>
  modelDefinition("model", {
    name: "Model",
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 2048,
    ...overrides,
  });
const provider = (overrides: Partial<ExistingProviderConfig> = {}): ExistingProviderConfig => ({
  baseUrl: "https://config.example/v1",
  api: "openai-responses",
  apiKey: "CONFIG_KEY",
  models: [model()],
  ...overrides,
});
function mergeSecrets(
  nextProviders: Record<string, ProviderConfig>,
  existingProviders: Record<string, ExistingProviderConfig>,
) {
  return mergeWithExistingProviderSecrets({
    nextProviders,
    existingProviders,
    secretRefManagedProviders: new Set(),
  });
}

describe("models-config merge", () => {
  it("refreshes metadata while preserving explicit reasoning overrides", () => {
    const { input: _input, ...authored } = model({
      reasoning: false,
      cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 2_000_000,
      maxTokens: 200_000,
    });
    const merged = mergeProviderModels(
      { models: [model({ reasoning: true })] },
      { models: [authored] },
    );
    expect(merged.models).toEqual([{ ...authored, input: ["text"] }]);
  });

  it("uses compat from the owner of the configured local route", () => {
    const merged = mergeProviderModels(
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
    const merged = mergeSecrets(mergeProviders({ explicit: { openai: provider() } }), {
      " OpenAI ": provider({ baseUrl: "https://agent.example/v1", apiKey: "AGENT_KEY" }),
    });
    expect(Object.keys(merged)).toEqual(["openai"]);
    expect(merged.openai).toMatchObject({
      apiKey: "AGENT_KEY",
      baseUrl: "https://agent.example/v1",
    });
  });

  it("merges implicit and explicit provider headers", () => {
    const catalog = {
      api: "anthropic-messages",
      baseUrl: "https://api.example.com",
      models: [{ id: "model" }],
    };
    const merged = mergeProviderModels<ProviderModelCatalog>(
      { ...catalog, headers: { "User-Agent": "claude-code/0.1.0" } },
      { ...catalog, headers: { "X-Kimi-Tenant": "tenant-a" } },
    );
    expect(merged).toEqual({
      ...catalog,
      headers: { "User-Agent": "claude-code/0.1.0", "X-Kimi-Tenant": "tenant-a" },
    });
  });

  it("replaces a stale baseUrl when the model API surface changes", () => {
    const merged = mergeSecrets(
      {
        custom: provider({ api: undefined, models: [model({ api: "openai-responses" })] }),
      },
      {
        custom: provider({
          baseUrl: "https://agent.example/v1",
          apiKey: "AGENT_KEY",
          api: undefined,
          models: [model({ api: "openai-completions" })],
        }),
      },
    );
    expect(merged.custom).toMatchObject({
      apiKey: "AGENT_KEY",
      baseUrl: "https://config.example/v1",
    });
  });

  it.each([
    ["plaintext to env marker", "AGENT_KEY", "GOOGLE_API_KEY", "https://agent.example/v1"],
    [
      "non-env marker to plaintext",
      NON_ENV_SECRETREF_MARKER,
      "ALLCAPS_SAMPLE",
      "https://agent.example/v1",
    ],
    ["empty existing values", "", "CONFIG_KEY", ""],
  ])("uses current credentials for %s", (_name, oldKey, nextKey, oldUrl) => {
    const merged = mergeSecrets(
      { custom: provider({ apiKey: nextKey }) },
      { custom: provider({ apiKey: oldKey, baseUrl: oldUrl }) },
    );
    expect(merged.custom).toMatchObject({
      apiKey: nextKey,
      baseUrl: oldUrl || "https://config.example/v1",
    });
  });
});
