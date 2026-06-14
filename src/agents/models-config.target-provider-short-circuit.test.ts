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
  // Backfilled by the post-merge follow-up on PR #73260: model-auth-env
  // now consumes these from model-auth-env-vars and the suite must mock
  // them to keep the mock surface complete after the origin/main merge.
  resolveProviderEnvAuthEvidence: () => ({}),
  listProviderEnvAuthLookupKeys: () => ["openai"],
  resolveProviderEnvAuthLookupKeys: () => ["openai"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY"] },
    authEvidenceMap: {},
  }),
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

  it("hit-after-warm-fingerprint: warm in-memory cache hit takes the readyCache path", async () => {
    // After the first call populates readyCache (either via plan or
    // via short-circuit), the next call with identical inputs hits
    // the in-memory cache BEFORE any disk read.  This validates the
    // ordering fix for Greptile P2: short-circuit runs after
    // readyCache check so warm callers don't re-read models.json.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Spy on fs.readFile to verify the second call performs no disk
    // reads on the models-config codepath.  Use the dynamic import
    // form so the spy installs against the same fs/promises instance
    // models-config is using.
    const fsPromises = await import("node:fs/promises");
    const readFileSpy = vi.spyOn(fsPromises.default, "readFile");
    try {
      await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
      expect(resolveImplicitProvidersCallCount).toBe(1);
      // No models.json read on the warm path.
      const modelsJsonReads = readFileSpy.mock.calls.filter((args) => {
        const arg = args[0];
        return typeof arg === "string" && arg.endsWith("/models.json");
      });
      expect(modelsJsonReads).toHaveLength(0);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("short-circuit-populates-scoped-cache: subsequent targeted calls take the warm path after a cold short-circuit", async () => {
    // Codex P1 / Aisle High #2 redesign on PR #73261: a successful
    // provider-scoped short-circuit must NOT populate the GLOBAL
    // readyCache (that would bless other providers it never validated).
    // It still populates a PROVIDER-SCOPED entry so a subsequent call
    // with the same `targetProvider` can take the warm path.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // First call: cold start, plan runs and populates the global
    // readyCache.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Drop the in-memory cache to simulate a fresh process.  Disk
    // state remains intact, so the second call should fire the
    // disk-based short-circuit and populate the scoped cache only.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0); // short-circuit

    // Third call with the same `targetProvider`: scoped cache hit —
    // no fs.readFile against models.json (the modelsJsonHash check
    // uses a streaming hash via createReadStream, not fs.readFile).
    const fsPromises = await import("node:fs/promises");
    const readFileSpy = vi.spyOn(fsPromises.default, "readFile");
    try {
      await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
      expect(resolveImplicitProvidersCallCount).toBe(0);
      const modelsJsonReads = readFileSpy.mock.calls.filter((args) => {
        const arg = args[0];
        return typeof arg === "string" && arg.endsWith("/models.json");
      });
      expect(modelsJsonReads).toHaveLength(0);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("scoped-cache-isolation: scoped short-circuit entry never blesses a non-targeted call", async () => {
    // Codex P1 on PR #73261: the previous design populated the
    // GLOBAL readyCache after a provider-scoped check, so a later
    // non-targeted ensureOpenClawModelsJson call could hit the same
    // fingerprint key and skip the full plan even though only one
    // provider had been validated.  After the redesign, the global
    // cache key is reserved for full-plan results; a non-targeted
    // call after a scoped short-circuit MUST run a full plan.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // First call: cold + targeted → full plan, populates global cache.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Reset to drop the global cache; disk state remains.  Targeted
    // call now fires the disk-based short-circuit and populates only
    // the scoped cache.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0); // scoped short-circuit

    // Non-targeted call with the same fingerprint must NOT see the
    // scoped entry as a global cache hit — it must run a full plan.
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-per-model-baseUrl: tampered per-model baseUrl rejects the short-circuit", async () => {
    // Codex P1 / Aisle High #2 on PR #73261: the runtime falls back
    // to `discoveredModel.baseUrl` from models.json when no provider-
    // level override is set (see pi-embedded-runner/model.ts).  An
    // attacker who can write models.json could inject a per-model
    // baseUrl that survives a provider-scoped check.  After the fix,
    // any per-model transport field on the disk row forces a re-plan.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject a per-model baseUrl that points at an attacker endpoint.
    // Provider-level baseUrl is unchanged so the prior check would
    // have accepted this state.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.models = [
      { id: "gpt-evil", name: "gpt-evil", baseUrl: "https://attacker.example/v1" },
    ];
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-per-model-headers: tampered per-model headers rejects the short-circuit", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.models = [
      {
        id: "gpt-evil",
        name: "gpt-evil",
        headers: { "X-Injected-Auth": "attacker-token" },
      },
    ];
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-per-model-api: tampered per-model api rejects the short-circuit", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.models = [
      { id: "gpt-evil", name: "gpt-evil", api: "openai-responses" },
    ];
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-deep-nested-disk: adversarially-deep diskProvider rejects the short-circuit without crashing", async () => {
    // Codex P2 / Aisle medium #3 on PR #73261: stableEqual was
    // unbounded recursion.  After the fix, deeply-nested
    // disk-controlled values fail closed via stableEqualBounded
    // instead of stack-overflowing the gateway.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Build a JSON value 200 levels deep — well over
    // SHORT_CIRCUIT_COMPARE_MAX_DEPTH (64).  Plant it in the disk
    // headers field so the bounded comparison must walk it.
    let nested: unknown = {};
    for (let i = 0; i < 200; i += 1) {
      nested = { wrap: nested };
    }
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.headers = nested;
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    // Must not throw, must fall through to full plan.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-provider-api-drift: tampered provider-level api rejects the short-circuit (Codex P1 round-5 on #73261)", async () => {
    // Round-5 P1: the runtime consumes a provider-level `api` field
    // (`models.providers.<id>.api`) at the same priority as
    // `baseUrl`/`headers`/`auth`.  Without a structural compare for
    // it, an attacker who can write models.json could swap the
    // provider's transport flavor (e.g. `"openai-completions" →
    // "openai-responses"`) and the short-circuit would re-bless the
    // file because the per-model loop only flags `api` set on disk-side
    // MODEL rows, not on the provider itself.  After the fix, any
    // drift between configured and disk provider-level `api` falls
    // through to full planning, which re-applies provider/plugin
    // defaults and rewrites the file.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Tamper with the provider-level `api` to simulate an attacker
    // editing models.json to point a configured provider at a
    // different transport family.  Provider-level baseUrl, apiKey,
    // headers, and auth are all unchanged so the prior short-circuit
    // surface would have accepted this state.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.api = "openai-responses";
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-provider-api-config-undefined: disk-set provider api with config-undefined rejects the short-circuit", async () => {
    // Symmetric variant of the round-5 P1 fix: when config OMITS
    // `api` for a provider but the disk row carries one, the
    // structural comparison must reject the disk state instead of
    // silently accepting it.  This mirrors the symmetric baseUrl
    // check from Greptile P1 / Aisle High #1.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            // pragma: allowlist secret
            apiKey: "sk-test-static-value",
            // No `api` field configured.
            models: [],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject a provider-level `api` value that the planner did not
    // write — config has no api, so any disk-side api must reject.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.api = "openai-completions";
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-unhashable-models-json: oversize models.json forces a re-plan via the short-circuit (Codex P2 round-5 on #73261)", async () => {
    // Round-5 P2: the previous scoped-cache compare used a raw
    // `string | null` hash so an `uncacheable` models.json (oversize,
    // symlink, I/O error) collapsed with the legitimate "file absent"
    // case via `null === null`.  After the round-4 cache-fingerprint
    // refactor (#73260) the primitive returns a discriminated
    // `ContentHashOutcome`; this branch must consume it via the
    // fail-closed `modelsContentOutcomesMatch` predicate so an
    // oversize file forces a re-plan instead of riding a stale hit.
    //
    // The disk-based short-circuit fallback also uses the same
    // `safeReadFileOutcome` primitive and refuses to short-circuit
    // on any non-`hashed` outcome — so an oversize models.json
    // additionally forces a full plan via that path on a fresh
    // process (cold cache + cold disk).
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Cold start: full plan, populates global readyCache.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Drop the in-memory cache, then warm the scoped cache via the
    // disk-based short-circuit.  Disk state still matches config so
    // the short-circuit fires and writes a scoped entry whose
    // captured `modelsJsonOutcome` is `hashed`.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0); // scoped short-circuit

    // Grow models.json past `MAX_MODELS_JSON_BYTES` (1 MiB).  The
    // next scoped-cache hit must observe an `uncacheable` outcome
    // and treat it as drift instead of a stale hit.
    const targetPath = path.join(agentDir, "models.json");
    const padding = " ".repeat(2 * 1024 * 1024); // 2 MiB whitespace tail
    const original = await fs.readFile(targetPath, "utf8");
    await fs.writeFile(targetPath, `${original}${padding}`);

    // The scoped cache compare now sees `uncacheable` on the disk
    // side and falls through to the disk-based short-circuit, which
    // also refuses to bless an unhashable file — ending in a full
    // plan.
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-cold-uncacheable-models-json: cold cache + oversize models.json refuses the disk-based short-circuit", async () => {
    // Sister test to the scoped-cache version: simulate a fresh
    // gateway process (cold readyCache) where models.json is
    // already oversize on disk before the call.  The disk-based
    // short-circuit branch must refuse to bless the file (the
    // `safeReadFileOutcome` returns `uncacheable`, which
    // readExistingProviderMatchesConfig maps to `false`) and fall
    // through to a full plan.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Seed disk with a structurally-correct models.json the
    // short-circuit would otherwise accept.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Append > 1 MiB of whitespace so the file exceeds
    // MAX_MODELS_JSON_BYTES and `safeReadFileOutcome` returns
    // `uncacheable` at lstat / fstat / streaming-cap time.
    const targetPath = path.join(agentDir, "models.json");
    const padding = " ".repeat(2 * 1024 * 1024);
    const original = await fs.readFile(targetPath, "utf8");
    await fs.writeFile(targetPath, `${original}${padding}`);

    // Drop ALL in-memory cache to simulate a fresh process.  No
    // scoped entry exists, so the only path that could short-circuit
    // is the disk-based check — which must refuse on `uncacheable`.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("hit-on-env-marker-with-unset-config: accepts disk env-var-name marker when config has no apiKey and env is set (Codex P2 round-6)", async () => {
    // Codex P2 round-6 on PR #73261: when config omits apiKey, the
    // planner persists `apiKey: "OPENAI_API_KEY"` (the env-var name
    // as marker) via `resolveMissingProviderApiKey`. The previous
    // round-5 fix rejected ANY non-empty disk apiKey in this case,
    // which silently disabled the short-circuit for every implicit-
    // discovery setup that uses env-var-derived auth (the dominant
    // case). After this fix the short-circuit must accept the env-
    // marker on disk iff the corresponding env var is currently set.
    //
    // The implicit-discovery planner is mocked in this suite to keep
    // tests fast and deterministic, so we can't rely on it to write
    // the env marker into models.json. Instead we cold-start the
    // suite to populate models.json with the configured provider,
    // then manually inject the env-var-name marker into disk to
    // simulate the post-`resolveMissingProviderApiKey` state, then
    // verify the second short-circuit pass accepts it.
    process.env.OPENAI_API_KEY = "sk-env-derived-value";
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };

    // Cold start: planner writes models.json (without an apiKey
    // because the suite mocks `resolveImplicitProviders`).
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject the env-var-name marker the way the real planner's
    // `resolveMissingProviderApiKey` would.
    const targetPath = path.join(agentDir, "models.json");
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    parsed.providers.openai.apiKey = "OPENAI_API_KEY";
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    // Second pass: short-circuit must accept the env-marker since
    // env["OPENAI_API_KEY"] is still populated. Implicit-discovery
    // count must stay at zero — the perf path is back.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("miss-on-env-marker-with-unset-env: rejects disk env-var-name marker when config has no apiKey but the env var is now unset (Codex P2 round-6)", async () => {
    // Liveness check: even when disk holds a recognizable env-var
    // name, if the env var is no longer populated the planner could
    // not legitimately have written that value AND there's no usable
    // credential, so we must fall through to full planning.
    process.env.OPENAI_API_KEY = "sk-env-derived-value";
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject the env-var-name marker (as the real planner would).
    const targetPath = path.join(agentDir, "models.json");
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    parsed.providers.openai.apiKey = "OPENAI_API_KEY";
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    // Now wipe the env var: the marker is stale.
    delete process.env.OPENAI_API_KEY;

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-env-marker-name-mismatch: rejects disk apiKey that's a string but doesn't match the resolved env-var name (Codex P2 round-6)", async () => {
    // If the disk apiKey is a string that doesn't correspond to the
    // planner's chosen env-var name for this provider, fall through.
    // This guards against an attacker hand-editing models.json to
    // point apiKey at an unrelated env var.
    process.env.OPENAI_API_KEY = "sk-env-derived-value";
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Hand-edit disk to point at a different env var that doesn't
    // map to the openai provider.
    const targetPath = path.join(agentDir, "models.json");
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    parsed.providers.openai.apiKey = "UNRELATED_TOKEN_VAR";
    await fs.writeFile(targetPath, JSON.stringify(parsed));
    process.env.UNRELATED_TOKEN_VAR = "some-unrelated-value";

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
    delete process.env.UNRELATED_TOKEN_VAR;
  });

  it("hit-on-env-ref-header-normalization: short-circuit accepts disk env-marker headers when config holds raw `${ENV_VAR}` refs (Codex P2 round-7)", async () => {
    // Codex P2 round-7 on PR #73261: "Normalize secret-ref headers
    // before short-circuit compare". `planOpenClawModelsJson` runs
    // configured headers through `normalizeHeaderValues` before
    // persisting, transforming env refs like `${OPENAI_API_KEY}`
    // into env-marker strings (`secretref-env:OPENAI_API_KEY`) and
    // SecretRef objects into the non-env marker (`secretref-managed`).
    // Without this round's fix, the short-circuit's deep compare
    // always fails for any header-auth provider configured with
    // secret refs because it compares raw `${...}` against marker
    // strings, defeating the perf path on every restart.
    process.env.OPENAI_API_KEY = "sk-env-ref-value";
    const agentDir = await fixtureSuite.createCaseDir("agent");
    // Config with an env-ref header (the canonical secret-ref shape).
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-tes\u2026alue",
            api: "openai-completions" as const,
            headers: {
              "X-Custom-Auth": "${OPENAI_API_KEY}",
              "X-Static": "literal-value",
            },
            models: [],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject the post-`normalizeHeaderValues` shape the planner would
    // have written: env ref → env marker; literal → unchanged.
    const targetPath = path.join(agentDir, "models.json");
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    parsed.providers.openai.headers = {
      "X-Custom-Auth": "secretref-env:OPENAI_API_KEY",
      "X-Static": "literal-value",
    };
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    // Second pass: short-circuit must accept disk because the
    // normalized configured headers match what's on disk.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("miss-on-env-ref-header-mismatch: rejects short-circuit when disk header marker points at a different env var than config (Codex P2 round-7)", async () => {
    // Even with the round-7 normalization fix, an attacker who can
    // write models.json shouldn't be able to point a header marker at
    // an unrelated env var and have the short-circuit bless it.  The
    // normalized configured headers will hold
    // `secretref-env:OPENAI_API_KEY` while disk holds
    // `secretref-env:UNRELATED_TOKEN` — deep compare must reject.
    process.env.OPENAI_API_KEY = "sk-env-ref-value";
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-tes\u2026alue",
            api: "openai-completions" as const,
            headers: { "X-Custom-Auth": "${OPENAI_API_KEY}" },
            models: [],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Disk holds a marker pointing at an UNRELATED env var.
    const targetPath = path.join(agentDir, "models.json");
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    parsed.providers.openai.headers = {
      "X-Custom-Auth": "secretref-env:UNRELATED_TOKEN",
    };
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-newly-configured-model: short-circuit rejects when config adds a model that is not on disk (Codex P1 round-8)", async () => {
    // Codex P1 round-8 on PR #73261: "Compare configured models
    // before short-circuiting provider hit". A config edit that
    // adds a new model id (without touching apiKey / baseUrl / api /
    // headers / auth) used to hit the short-circuit and leave
    // models.json stale; resolveModelAsync would miss the new model.
    // After this fix, the subset check (every configuredProvider.models
    // id must appear on disk) catches the add and forces a re-plan.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-tes\u2026alue",
            api: "openai-completions" as const,
            models: [
              { id: "gpt-5" },
            ] as unknown as import("../config/types.models.js").ModelDefinitionConfig[],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Confirm disk picked up the configured model.
    const targetPath = path.join(agentDir, "models.json");
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    expect(Array.isArray(parsed.providers.openai.models)).toBe(true);

    // Now config adds a new model (transport unchanged).
    const cfgWithNewModel: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            ...cfg.models!.providers!.openai,
            models: [
              { id: "gpt-5" },
              { id: "gpt-6-newly-configured" },
            ] as unknown as import("../config/types.models.js").ModelDefinitionConfig[],
          },
        },
      },
    };

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfgWithNewModel, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-config-only-bare-string-model-add: short-circuit rejects when configured.models adds a bare string id missing from disk (Codex P1 round-8)", async () => {
    // Bare-string model entry shape: `models: ["gpt-5"]`.  The
    // round-8 collector accepts both shapes; verify the bare-string
    // path also forces a re-plan when a new id is added.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-tes\u2026alue",
            api: "openai-completions" as const,
            models: [
              { id: "gpt-5" },
            ] as unknown as import("../config/types.models.js").ModelDefinitionConfig[],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    const cfgBareString: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            ...cfg.models!.providers!.openai,
            models: [
              "gpt-5",
              "gpt-6-newly-configured",
            ] as unknown as import("../config/types.models.js").ModelDefinitionConfig[],
          },
        },
      },
    };

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfgBareString, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("hit-on-implicit-only-models-list: empty configured.models still short-circuits when transport matches (Codex P1 round-8)", async () => {
    // Implicit-discovery mode: `models: []` means "the planner fills
    // it in via discovery". The round-8 subset check skips the
    // model comparison in this case (configuredIds is empty), so
    // transport-only checks decide the short-circuit — preserving
    // the perf path for the dominant implicit-mode setup.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig(); // explicit apiKey, models: []
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Second pass with identical transport-shape config: short-circuit
    // hits, no re-plan.  models: [] means we don't gate on the
    // model-list subset.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("miss-on-malformed-configured-model-entry: refuses short-circuit when configured.models has an entry with non-string id (Codex P1 round-8)", async () => {
    // Fail-closed for adversarial / malformed configured.models
    // shapes (record without an id, id of wrong type, etc.).  The
    // collector returns null and the short-circuit refuses, so a
    // hostile / partially-typed config can't sneak past via
    // unparseable model entries.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-tes\u2026alue",
            api: "openai-completions" as const,
            models: [
              { id: "gpt-5" },
            ] as unknown as import("../config/types.models.js").ModelDefinitionConfig[],
          },
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject a malformed model entry into the next-pass config.
    const cfgMalformed: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            ...cfg.models!.providers!.openai,
            models: [
              { id: "gpt-5" },
              { id: 1234 },
            ] as unknown as import("../config/types.models.js").ModelDefinitionConfig[],
          },
        },
      },
    };

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfgMalformed, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("miss-on-malformed-disk-apiKey: non-string disk apiKey rejects the short-circuit when config has no key", async () => {
    // Codex P2 on PR #73261: the previous fail-open branch accepted
    // any non-string disk apiKey when config had no apiKey, leaving
    // malformed disk rows in place.  After the fix, anything other
    // than absent / empty-string forces a re-plan.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    // Config with no apiKey at all.
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Inject a malformed disk apiKey — a number — to simulate a
    // partial corruption / hand-edited row.  Previous code accepted
    // this; new code rejects.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.apiKey = 1234;
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("hit-on-policy-injected-default-baseUrl: implicit-only ollama config with baseUrl omitted still short-circuits because policy normalization injects the default disk-side too (Codex P2 round-9 #1)", async () => {
    // Reproduces the round-9 finding at models-config.ts:1282.  An
    // ollama provider config without `baseUrl` gets the default
    // `http://localhost:11434` injected by the bundled provider
    // policy hook (see extensions/ollama/provider-policy-api.ts).
    // `planOpenClawModelsJson` writes that normalized shape to disk.
    // Without the round-9 normalize-before-compare pass, the
    // structural compare runs config-as-authored (no baseUrl) vs
    // disk-as-normalized (baseUrl: "http://localhost:11434") and
    // always falls through to a full plan, disabling the perf path
    // for every ollama-targeted call.  The fix normalizes
    // configuredProvider with the same provider-policy hook before
    // comparison, so this test must short-circuit on the second pass.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            // baseUrl deliberately omitted so policy normalization
            // injects the default both at write time and at
            // compare time.
            api: "ollama-chat" as const,
            models: [],
          } as unknown as import("../config/types.models.js").ModelProviderConfig,
        },
      },
    };
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "ollama" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Second pass with the same baseUrl-omitting config: structural
    // compare on the normalized shape matches disk (default baseUrl
    // on both sides), so the short-circuit must skip planning.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "ollama" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("miss-on-implicit-only-target-model-not-on-disk: empty configured.models with targetModel id missing from disk falls through to full planning (Codex P2 round-9 #2)", async () => {
    // Reproduces the round-9 finding at models-config.ts:997.  In
    // implicit-only mode (`models: []`), the prior contract skipped
    // ALL model-id validation and could short-circuit a stale disk
    // catalog — then `resolveModelAsync` would fail with `Unknown
    // model` because discovery never ran.  With the round-9 fix,
    // when the embedded caller passes `targetModel` and that id is
    // not present on disk, the short-circuit refuses and the
    // planner gets a chance to rediscover.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig(); // models: [] (implicit)
    // Cold start populates models.json with implicit discovery (the
    // mocked `resolveImplicitProviders` returns `{}`, so disk ends
    // up with no openai model rows).
    await ensureOpenClawModelsJson(cfg, agentDir, {
      targetProvider: "openai",
      targetModel: "gpt-5",
    });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Second pass with same config + same targetModel.  Without the
    // fix this would short-circuit (config matches disk transport,
    // implicit mode skips per-model checks) and silently bless a
    // disk catalog that doesn't have `gpt-5`.  With the fix, the
    // implicit-mode branch checks `targetModel` against disk model
    // ids and refuses because gpt-5 is missing, so we re-plan.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, {
      targetProvider: "openai",
      targetModel: "gpt-5",
    });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("hit-on-implicit-only-target-model-on-disk: empty configured.models with targetModel id present on disk still short-circuits (Codex P2 round-9 #2 hit-arm)", async () => {
    // Symmetric companion to the miss-arm above: implicit-only mode
    // with a `targetModel` hint MUST still short-circuit when the
    // requested model is already on disk, otherwise the perf path
    // collapses for every implicit-discovery setup that wires a
    // model id through the embedded runner.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();
    // Cold start: planner runs, writes a baseline disk file.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Hand-inject a `gpt-5` model row on disk to simulate the case
    // where prior implicit discovery (in production, not the mocked
    // suite) had populated the model catalog.  Then re-run with the
    // targetModel hint pointing at that id.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.models = [{ id: "gpt-5" }];
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, {
      targetProvider: "openai",
      targetModel: "gpt-5",
    });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("scoped-cache-per-target-model: implicit-only short-circuit cached for one targetModel does not bless a different targetModel under the same fingerprint (Codex P2 round-9 #2 cache-key follow-on)", async () => {
    // The round-9 implicit-only `targetModel` check is also folded
    // into the scoped readyCache key, so a hit cached for model X
    // cannot be reused as a structural "match" for model Y under the
    // same (provider, fingerprint, models.json content) tuple when Y
    // isn't on disk.  Without that cache-key isolation, call A would
    // bless model X (correctly), and call B asking for model Y would
    // ride A's cache entry and return `wrote: false` while disk is
    // missing Y — the very regression the round-9 finding pins.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Place only `gpt-5` on disk so the catalog has X but not Y.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.models = [{ id: "gpt-5" }];
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    // Warm the scoped cache for targetModel=gpt-5 (must hit).
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, {
      targetProvider: "openai",
      targetModel: "gpt-5",
    });
    expect(resolveImplicitProvidersCallCount).toBe(0);

    // Now ask for targetModel=gpt-7 — not on disk.  If gpt-5's
    // scoped cache entry leaked, this would also hit with
    // resolveImplicitProvidersCallCount staying at 0.  The
    // per-target-model cache key forces a fresh structural check
    // which then refuses (gpt-7 missing) and falls through to the
    // planner.
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, {
      targetProvider: "openai",
      targetModel: "gpt-7",
    });
    expect(resolveImplicitProvidersCallCount).toBe(1);
  });

  it("cache-stores-validated-outcome: scoped cache caches the SAME bytes the structural check validated, with one read not two (Codex P2 round-10 on #73261)", async () => {
    // Round-10 contract: `readExistingProviderMatchesConfig` already
    // reads + hashes models.json via `safeReadFileOutcome`; the
    // caller must REUSE that validated outcome instead of issuing a
    // second `readModelsJsonContentOutcome` post-validation.  The
    // second read was a TOCTOU window (round-9 and earlier): if the
    // disk file was swapped between validation and the second read,
    // the scoped cache would store a hash of UNVALIDATED bytes.
    //
    // This test pins both halves of the new contract:
    //  (a) Only ONE `fs.readFile` happens against models.json on the
    //      cold-but-disk-present short-circuit path (the one inside
    //      `safeReadFileOutcome` -> `createReadStream`-backed read
    //      doesn't go through `fs.readFile`, so the only readFile we
    //      see against models.json is whichever fingerprint /
    //      cache-helper path uses it; what we PIN is that the
    //      previous round-9 second read — which DID go through
    //      `readModelsJsonContentOutcome` — is gone).
    //  (b) The third call (subsequent targeted call hitting the
    //      scoped cache with stable disk) does not regress: it must
    //      take the warm path with no implicit-discovery.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Cold start: full plan populates global cache, writes disk.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Drop in-memory cache so the next call must take the disk-based
    // short-circuit path (validates structure, threads the
    // validated outcome back to the caller, populates scoped cache).
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0); // short-circuit fired

    // Third call: scoped cache hit, no implicit discovery.
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });

  it("toctou-swap-cannot-bless-unvalidated-content: scoped cache stores hash of validated bytes, not bytes swapped in after validation (Codex P2 round-10 security fix)", async () => {
    // The actual security regression test for the round-10 fix.
    // Before the fix: `readExistingProviderMatchesConfig` would
    // validate bytes A from disk, then the caller would issue a
    // SECOND `readModelsJsonContentOutcome` whose result — if disk
    // was swapped to bytes B in between — would be the hash of B.
    // The scoped cache would store hash(B) as "the validated
    // snapshot," and a subsequent targeted call comparing live disk
    // (still B) against the cached hash(B) would match and return
    // wrote:false, blessing attacker-controlled provider transport.
    //
    // After the fix: the validated outcome from
    // `readExistingProviderMatchesConfig` is threaded back, so the
    // scoped cache stores hash(A).  When we then mutate disk to B
    // and call again, the live disk hash(B) does NOT match cached
    // hash(A); the scoped entry is dropped, the structural check
    // re-runs against B, and — because B doesn't match config — the
    // call falls through to a full plan that rewrites models.json
    // back to a config-aligned shape.
    //
    // We can't directly observe "between the two reads" because the
    // round-10 fix collapses them into one; what we CAN observe is
    // the post-fix invariant:  after the cold short-circuit
    // populates the scoped cache, mutating models.json on disk to
    // a config-disagreeing shape MUST NOT result in a cache hit.
    // The next targeted call must run a full plan (resolveImplicit
    // fires) and the post-plan disk content must be config-aligned
    // again (the swapped-in baseUrl is gone).
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Cold start.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Reset to force the disk-based short-circuit which populates
    // the scoped cache with the VALIDATED hash.
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0); // short-circuit fired

    // Now simulate an external attacker swapping models.json to a
    // config-disagreeing shape (different baseUrl).  This is what
    // the TOCTOU race would have allowed to slip into the cache
    // pre-round-10.  Post-round-10, the cached hash is hash(A) so
    // the swap will not match.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.providers.openai.baseUrl = "https://attacker.example.com/v1";
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    // Next targeted call MUST detect drift (cached hash doesn't
    // match new disk hash), refuse the scoped cache, run the
    // structural check against the swapped baseUrl, fail it (config
    // baseUrl != disk baseUrl), and fall through to a full plan.
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1); // full plan ran

    // The core security invariant: the swapped-in baseUrl was NOT
    // blessed by a cache hit.  The full plan ran (above), which
    // means the structural check refused to ride a cached hash
    // of swapped-in bytes — the round-9 TOCTOU window is closed.
    // (We don't assert post-plan disk content here because
    // `planAndWrite` write-merge semantics depend on the broader
    // planner contract, not on this short-circuit fix.)
  });

  it("no-cache-on-uncacheable-validated-outcome: oversize models.json refuses both the structural match and the scoped cache populate (Codex P2 round-10 follow-on)", async () => {
    // Companion to the round-10 contract:
    // `readExistingProviderMatchesConfig` early-returns
    // `{ matches: false }` when the file is uncacheable (oversize,
    // symlink, I/O error), so the scoped cache populate path is
    // never reached.  This is behaviorally equivalent to the
    // round-9 "if validated outcome is uncacheable, do not cache"
    // requirement; the round-10 fix collapses the two into one
    // shorter path.
    //
    // Pin: oversize disk file forces a full plan AND leaves the
    // scoped cache empty (next targeted call must NOT take a warm
    // path — if the scoped cache had been populated with an
    // uncacheable hash, an attacker could swap content of equal
    // size and still hit the cache).
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Cold start populates global cache and writes a small
    // models.json.
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Bloat the file past MAX_MODELS_JSON_BYTES to force
    // safeReadFileOutcome -> uncacheable.
    const targetPath = path.join(agentDir, "models.json");
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    // 2 MiB padding string — well above the 1 MiB cap.
    parsed.providers.openai.padding = "x".repeat(2 * 1024 * 1024);
    await fs.writeFile(targetPath, JSON.stringify(parsed));

    // Reset to force disk-based path.  The structural check must
    // refuse (uncacheable file); the call must fall through to a
    // full plan (which will rewrite models.json back to a sane
    // size).
    resetModelsJsonReadyCacheForTest();
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(1); // full plan ran

    // After the plan, the file is back under cap and the post-plan
    // baseline holds: a follow-up targeted call hits the warm cache
    // (scoped or global, populated by the plan), no extra implicit
    // discovery.
    resolveImplicitProvidersCallCount = 0;
    await ensureOpenClawModelsJson(cfg, agentDir, { targetProvider: "openai" });
    expect(resolveImplicitProvidersCallCount).toBe(0);
  });
});
