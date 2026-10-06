import { beforeAll, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
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
): ProviderConfig["models"][number] => ({
  id: "model",
  name: "Model",
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

  it.each(["https://catalog.example/v1", "http://127.0.0.1:9000/v1"])(
    "uses compat from the owner of the configured route %s",
    (baseUrl) => {
      const merged = mergeProviderModels(
        provider({
          baseUrl: "https://catalog.example/v1/",
          models: [model({ compat: { supportsTools: true, supportsTemperature: false } })],
        }),
        provider({
          baseUrl,
          models: [model({ compat: { supportsTools: false, supportsTemperature: true } })],
        }),
      );
      expect(merged.models[0]?.compat).toEqual(
        baseUrl.startsWith("https:")
          ? { supportsTools: true, supportsTemperature: false }
          : { supportsTools: false, supportsTemperature: true },
      );
    },
  );

  it.each([
    { keys: ["openai", "OpenAI"], expected: ["openai", "anthropic"], winner: "openai" },
    { keys: ["OpenAI", "openai"], expected: ["anthropic", "openai"], winner: "openai" },
    { keys: ["OpenAI", " OPENAI "], expected: ["openai", "anthropic"], winner: " OPENAI " },
  ])("resolves provider collisions in order $keys", ({ keys, expected, winner }) => {
    const [first, last] = keys;
    const merged = mergeProviders({
      explicit: {
        [first!]: provider({ baseUrl: first }),
        anthropic: provider(),
        [last!]: provider({ baseUrl: last }),
      },
    });
    expect(Object.keys(merged)).toEqual(expected);
    expect(merged.openai?.baseUrl).toBe(winner);
  });

  it("drops invalid stale catalogs while retaining auth-only providers", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: { openai: provider() },
      existingProviders: {
        invalid: provider({ baseUrl: undefined }),
        "auth-only": provider({ models: [], apiKey: "AGENT_KEY" }),
      },
      secretRefManagedProviders: new Set(),
    });
    expect(merged.invalid).toBeUndefined();
    expect(merged["auth-only"]?.apiKey).toBe("AGENT_KEY");
    expect(merged.openai).toBeDefined();
  });

  it("preserves existing secrets after provider key normalization", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: mergeProviders({ explicit: { openai: provider() } }),
      existingProviders: {
        " OpenAI ": provider({ baseUrl: "https://agent.example/v1", apiKey: "AGENT_KEY" }),
      },
      secretRefManagedProviders: new Set(),
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
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: provider({ api: undefined, models: [model({ api: "openai-responses" })] }),
      },
      existingProviders: {
        custom: provider({
          baseUrl: "https://agent.example/v1",
          apiKey: "AGENT_KEY",
          api: undefined,
          models: [model({ api: "openai-completions" })],
        }),
      },
      secretRefManagedProviders: new Set(),
    });
    expect(merged.custom).toMatchObject({
      apiKey: "AGENT_KEY",
      baseUrl: "https://config.example/v1",
    });
  });

  it.each([
    {
      name: "plaintext to env marker",
      oldKey: "AGENT_KEY",
      nextKey: "GOOGLE_API_KEY",
      oldUrl: "https://agent.example/v1",
    },
    {
      name: "non-env marker to plaintext",
      oldKey: NON_ENV_SECRETREF_MARKER,
      nextKey: "ALLCAPS_SAMPLE",
      oldUrl: "https://agent.example/v1",
    },
    { name: "empty existing values", oldKey: "", nextKey: "CONFIG_KEY", oldUrl: "" },
  ])("uses current credentials for $name", ({ oldKey, nextKey, oldUrl }) => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: { custom: provider({ apiKey: nextKey }) },
      existingProviders: { custom: provider({ apiKey: oldKey, baseUrl: oldUrl }) },
      secretRefManagedProviders: new Set(),
    });
    expect(merged.custom).toMatchObject({
      apiKey: nextKey,
      baseUrl: oldUrl || "https://config.example/v1",
    });
  });
});
