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
});
