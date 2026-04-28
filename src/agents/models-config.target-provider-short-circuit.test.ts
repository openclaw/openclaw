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
 * Track implicit-provider-discovery invocations so we can verify whether
 * the targetProvider short-circuit fired (no call) or fell through to
 * full planning (one call per ensureOpenClawModelsJson invocation).
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

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

const fixtureSuite = createFixtureSuite("openclaw-models-target-provider-");

function createOpenAiConfig(apiKey = "sk-test-static-value"): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          // pragma: allowlist secret
          apiKey,
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
  ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  installModelsConfigTestHooks();
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

/**
 * Six tests for the targetProvider short-circuit semantics on PR #72869
 * (Greptile P2 + Aisle High #2 + Codex P1).
 *
 * The short-circuit was previously a "presence-only" check that fired when
 * any non-empty credential was on disk for the requested provider. That
 * silently bypassed configuration drift (rotated keys, attacker-tampered
 * baseUrl/headers/auth). The fix structurally compares disk vs. config
 * before short-circuiting and falls through to full planning on any
 * mismatch.
 */
describe("ensureOpenClawModelsJson targetProvider short-circuit", () => {
  it("hit-on-match: full disk-vs-config match short-circuits planning", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // First call: cold start, must run plan and write models.json.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Second call with identical config + intact disk state: short-circuit
    // path now sees a structural match and returns without re-planning.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("miss-on-rotated-key: config apiKey change forces a full plan", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    // pragma: allowlist secret
    const cfgOriginal = createOpenAiConfig("sk-test-original-key");

    await ensureOpenClawModelsJson(cfgOriginal, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Rotate the key in config, simulate a gateway restart (clear in-memory
    // cache), and verify the next call falls through to planning instead of
    // returning stale on-disk state with the OLD key.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    // pragma: allowlist secret
    const cfgRotated = createOpenAiConfig("sk-test-rotated-key");
    await ensureOpenClawModelsJson(cfgRotated, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-baseUrl-change: tampered disk baseUrl rejects the short-circuit", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Simulate an attacker editing models.json to redirect baseUrl to an
    // exfiltration endpoint. Clear the in-memory cache (e.g. gateway
    // restart) so the short-circuit path is the only thing that could
    // trust this disk state.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.baseUrl = "https://attacker.example/v1";
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    // Falls through to plan, which will rewrite the file with the correct
    // baseUrl from config.
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-tampered-headers: any disk header drift rejects the short-circuit", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject attacker-supplied headers (e.g. Authorization override) onto
    // the disk row. Config has none, so the structural comparison must
    // reject this and force a full plan that overwrites with config shape.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.headers = { "X-Injected-Auth": "attacker-token" };
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-cold-cache: empty in-memory cache + missing disk file forces a plan", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // No prior writes — disk has no models.json. Even with targetProvider
    // set, the short-circuit cannot match against a non-existent file
    // and must fall through to the full plan.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("hit-after-warm-fingerprint: identical inputs reuse the in-memory cache without re-running plan", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Same config + same disk + warm in-memory cache: both the
    // targetProvider short-circuit AND the fingerprint cache hit are
    // available. Either way, no re-plan should fire.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // External edit to models.json after the warm cache populated must
    // invalidate the in-memory cache via the modelsJsonHash second factor
    // (Codex P1: previously the fingerprint alone was the key, so external
    // edits silently returned stale cached success).
    const targetPath = path.join(agentDir, "models.json");
    await fs.writeFile(
      targetPath,
      JSON.stringify({ providers: { openai: { baseUrl: "https://attacker.example/v1" } } }),
    );
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(2);
  });
});
