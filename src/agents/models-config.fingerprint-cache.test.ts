import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
} from "./models-config.e2e-harness.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => undefined,
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  PROVIDER_ENV_API_KEY_CANDIDATES: { openai: ["OPENAI_API_KEY"] },
  resolveProviderEnvApiKeyCandidates: () => ({ openai: ["OPENAI_API_KEY"] }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderConfigDefaultsWithPlugin: (config: OpenClawConfig) => config,
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: () => undefined,
  resetProviderRuntimeHookCacheForTest: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

/**
 * We track how many times the implicit-provider discovery pipeline runs so we
 * can verify that the in-memory cache keyed by the models.json target path
 * short-circuits subsequent calls when inputs have not meaningfully changed.
 */
let resolveImplicitProvidersCallCount = 0;
vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async () => {
      resolveImplicitProvidersCallCount += 1;
      return {};
    },
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/io.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/io.js").clearRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

const fixtureSuite = createFixtureSuite("openclaw-models-fingerprint-");

function createOpenAiConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-static-value", // pragma: allowlist secret
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

async function writeAuthProfiles(agentDir: string, profiles: unknown): Promise<void> {
  const target = path.join(agentDir, "auth-profiles.json");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(target, JSON.stringify(profiles));
}

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/io.js"));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
  resolveImplicitProvidersCallCount = 0;
  unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS]);
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

describe("ensureOpenClawModelsJson fingerprint cache", () => {
  it("reuses the cached result when inputs do not change", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(firstCount);
  });

  it("does not invalidate the cache when auth-profiles volatile fields rotate", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-first-token-value", // pragma: allowlist secret
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token-v1",
          refresh: "refresh-token-v1",
          expires: 1_700_000_000_000,
          accountId: "account-xyz",
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    // Simulate an OAuth token refresh: volatile fields (access/refresh/expires/token)
    // rotate, but the set of providers the user can use does not change.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-rotated-token-value", // pragma: allowlist secret
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token-v2-ROTATED",
          refresh: "refresh-token-v2-ROTATED",
          expires: 1_700_000_999_000,
          accountId: "account-xyz",
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(firstCount);
  });

  it("invalidates the cache when an auth profile is added or removed", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-first-token-value", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    await writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-first-token-value", // pragma: allowlist secret
        },
        "google:default": {
          type: "token",
          provider: "google",
          token: "google-api-key-added", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    // Structural change (new profile) must invalidate the cache.
    expect(resolveImplicitProvidersCallCount).toBe(firstCount + 1);
  });

  it("invalidates the cache when the config changes", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfgOne = createOpenAiConfig();
    const cfgTwo: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            ...cfgOne.models!.providers!.openai,
            baseUrl: "https://alt.example.com/v1",
          },
        },
      },
    };

    await ensureOpenClawModelsJson(cfgOne, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    await ensureOpenClawModelsJson(cfgTwo, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
  });
});
