import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
} from "./models-config.e2e-harness.js";
import type { ResolveImplicitProvidersForModelsJson } from "./models-config.plan.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => undefined,
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  PROVIDER_ENV_API_KEY_CANDIDATES: { openai: ["OPENAI_API_KEY"] },
  resolveProviderEnvApiKeyCandidates: () => ({ openai: ["OPENAI_API_KEY"] }),
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
 * We track how many times the implicit-provider discovery pipeline runs so we
 * can verify that the in-memory cache keyed by the models.json target path
 * short-circuits subsequent calls when inputs have not meaningfully changed.
 */
let resolveImplicitProvidersCallCount = 0;
let resolveImplicitProvidersHook:
  | ((params: Parameters<ResolveImplicitProvidersForModelsJson>[0]) => void | Promise<void>)
  | undefined;
vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async (
      params: Parameters<ResolveImplicitProvidersForModelsJson>[0],
    ) => {
      resolveImplicitProvidersCallCount += 1;
      await resolveImplicitProvidersHook?.(params);
      return {};
    },
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/io.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/io.js").clearRuntimeConfigSnapshot;
let buildModelsJsonSourceFingerprint: typeof import("./models-config.js").buildModelsJsonSourceFingerprint;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let prepareOpenClawModelsJsonSource: typeof import("./models-config.js").prepareOpenClawModelsJsonSource;
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

// Seed the canonical SQLite auth-profile store (the `auth_profile_store`
// row) that `ensureOpenClawModelsJson` now fingerprints — NOT the legacy
// `auth-profiles.json` file.  Synchronous upsert mirroring a real save.
function writeAuthProfiles(agentDir: string, profiles: unknown): void {
  writePersistedAuthProfileStoreRaw(profiles, agentDir);
}

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/io.js"));
  ({
    buildModelsJsonSourceFingerprint,
    ensureOpenClawModelsJson,
    prepareOpenClawModelsJsonSource,
    resetModelsJsonReadyCacheForTest,
  } = await import("./models-config.js"));
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
  resolveImplicitProvidersCallCount = 0;
  resolveImplicitProvidersHook = undefined;
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

  it("does not invalidate the cache when OAuth session fields rotate", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
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

    // Simulate an OAuth token refresh: access/refresh/expires fields
    // rotate, but the set of providers the user can use does not change.
    // These fields stay in AUTH_PROFILE_VOLATILE_FIELDS.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
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

  it("DOES invalidate the cache when a static type:token credential rotates (Codex/Greptile P2)", async () => {
    // Counterpart to the OAuth-rotation test above. Profiles with
    // `type: "token"` use the literal `token` key as a long-lived static
    // credential. The user rotating this credential must invalidate the
    // cache so the implicit-provider-discovery pipeline re-runs against
    // the new value (Codex/Greptile P2 on PR #72869: "token" used to be
    // in the volatile fields set, masking real auth-state changes).
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
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

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-rotated-token-value", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    // Static-credential rotation must trigger a re-plan.
    expect(resolveImplicitProvidersCallCount).toBe(firstCount + 1);
  });

  it("invalidates the cache when an auth profile is added or removed", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
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

    writeAuthProfiles(agentDir, {
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

  it("returns the post-ensure source fingerprint when provider discovery mutates auth profiles", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "before-provider-discovery", // pragma: allowlist secret
        },
      },
    });
    const preEnsureFingerprint = await buildModelsJsonSourceFingerprint(cfg, agentDir);
    if (!preEnsureFingerprint.cacheable) {
      throw new Error("expected the pre-ensure auth store to be cacheable");
    }

    resolveImplicitProvidersHook = (params) => {
      writeAuthProfiles(params.agentDir, {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "token",
            provider: "anthropic",
            token: "after-provider-discovery", // pragma: allowlist secret
          },
        },
      });
    };

    const prepared = await prepareOpenClawModelsJsonSource(cfg, agentDir);
    const postEnsureFingerprint = await buildModelsJsonSourceFingerprint(cfg, agentDir);
    if (!prepared.cacheable || !postEnsureFingerprint.cacheable) {
      throw new Error("expected the post-ensure auth store to be cacheable");
    }

    expect(prepared.fingerprint).toBe(postEnsureFingerprint.fingerprint);
    expect(prepared.fingerprint).not.toBe(preEnsureFingerprint.fingerprint);
    expect(resolveImplicitProvidersCallCount).toBe(1);
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

  it("forces a re-plan on every call while the auth-profile store stays oversize (fail-closed cap)", async () => {
    // A store payload over MAX_AUTH_PROFILES_BYTES is `uncacheable`, so the
    // readyCache is bypassed entirely and EVERY call must re-plan — even
    // when the payload is byte-identical to the previous oversize call.
    // Guards against an oversize state collapsing onto a single fingerprint
    // contribution and letting credential edits ride a stale cache.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm the cache with a small profile.
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "***", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Repeat call with the same small profile — cache hit, no re-plan.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Grow the store payload past the cap.  First oversize call: cache miss
    // (different effective state) → re-plan.
    const padding = "x".repeat(10 * 1024 * 1024); // 10 MiB > MAX_AUTH_PROFILES_BYTES
    writeAuthProfiles(agentDir, {
      version: 1,
      padding,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "***", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);

    // Repeat oversize call with byte-identical payload.  The store is
    // `uncacheable`, so the cache stays bypassed and we re-plan again.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(3);

    // Same again — still bypassed.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(4);

    // Restoring a small (different) profile re-enables caching, and
    // the next call after that should be a cache hit.
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "google:default": {
          type: "token",
          provider: "google",
          token: "google-restored", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(5);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(5);
  }, 30_000);

  it("forces a re-plan when the SQLite auth store is unreadable/corrupt (fail-closed, Codex P1 #90741)", async () => {
    // The durable-review P1: `readAuthProfilesStableOutcome` must distinguish a
    // legitimately ABSENT auth store (missing DB / row) from an UNREADABLE one
    // (SQLite open/query failure or malformed JSON cell).  Before the fix the
    // raw reader swallowed both failure shapes to `null`, so a corrupt or
    // partially-migrated auth DB fingerprinted as `absent` — a cacheable
    // outcome — and let stale provider/auth discovery ride a ready-cache hit
    // instead of forcing a fail-closed re-plan.  With the fix the corrupt store
    // reads `unreadable` → `uncacheable`, which never compares equal (not even
    // to itself), so EVERY call must re-plan while the store stays corrupt.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm the cache with a valid small store: a steady-state cache hit.
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "***", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Corrupt the on-disk SQLite auth DB so the read-only open / query throws.
    // This is the "unreadable store" the durable review flagged: it must NOT be
    // treated like a missing store.  Close pooled handles first so the file is
    // not held open, then overwrite with garbage.  (WAL/SHM sidecars from the
    // prior write would otherwise let SQLite recover, so clear them too.)
    closeOpenClawAgentDatabasesForTest();
    const authDbPath = resolveAuthProfileDatabasePath(agentDir);
    await fs.writeFile(authDbPath, "this is not a valid sqlite database file");
    await fs.rm(`${authDbPath}-wal`, { force: true });
    await fs.rm(`${authDbPath}-shm`, { force: true });

    await expect(buildModelsJsonSourceFingerprint(cfg, agentDir)).resolves.toEqual({
      agentDir,
      cacheable: false,
    });

    // First corrupt read: cache miss → re-plan.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);

    // Repeat with the byte-identical corrupt store.  `uncacheable` never
    // compares equal, so the cache stays bypassed and we re-plan again — the
    // fail-closed contract.  Under the buggy code this would be a cache hit
    // (corrupt store read as `absent`, two `absent` reads compare equal) and
    // the count would stay at 2.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(3);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(4);

    // Restoring a valid store re-enables caching.  Remove the corrupt file so
    // the writer can create a fresh DB (opening the garbage file writably would
    // itself throw "file is not a database"), then seed a valid (different)
    // store: the next call re-plans once, then the steady state hits again.
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(authDbPath, { force: true });
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "google:default": {
          type: "token",
          provider: "google",
          token: "google-restored", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(5);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(5);
  }, 30_000);

  it("forces a re-plan when the auth store row holds malformed JSON (fail-closed, Codex P1 #90741)", async () => {
    // Companion to the corrupt-DB case: the store row EXISTS and the SQLite
    // file opens cleanly, but the `store_json` cell holds a non-empty string
    // that `JSON.parse` rejects (partial write / truncation / external
    // tampering).  The old `parseJsonCell` swallowed the parse error to `null`,
    // so the fingerprint path read it as `absent` (cacheable).  The fix routes
    // a malformed cell to `unreadable` → `uncacheable`, so the store cannot be
    // trusted and every call re-plans until a valid payload is restored.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm with a valid store first.
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "***", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Overwrite the store row's JSON cell with a malformed (non-JSON) payload,
    // simulating a truncated/garbled persisted blob.  First close any pooled
    // agent DB handles so the file is not locked, then open a direct writable
    // SQLite connection and UPDATE the cell to a string that is NOT valid JSON.
    closeOpenClawAgentDatabasesForTest();
    const authDbPath = resolveAuthProfileDatabasePath(agentDir);
    const sqlite = requireNodeSqlite();
    const rawDb = new sqlite.DatabaseSync(authDbPath);
    try {
      rawDb.exec(
        "UPDATE auth_profile_store SET store_json = 'not-json-{' WHERE store_key = 'primary'",
      );
    } finally {
      rawDb.close();
    }

    await expect(buildModelsJsonSourceFingerprint(cfg, agentDir)).resolves.toEqual({
      agentDir,
      cacheable: false,
    });

    // The malformed cell reads `unreadable` → `uncacheable`: every call
    // re-plans.  Under the buggy code this would read `absent` and stay a hit
    // (count frozen at 1).
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(3);
  }, 30_000);

  it("invalidates the cache when models.json becomes unhashable (Codex P1 round-4 on #73260)", async () => {
    // Round-4 follow-up: the cache-hit predicate used to accept
    // `currentModelsJsonHash === settled.modelsJsonHash`, but
    // `readModelsJsonContentHash` returned null for several failure
    // modes (oversize, symlink, I/O error) in addition to the
    // legitimate "file absent" case.  An attacker who could put
    // models.json into any of those states could then mutate its
    // contents repeatedly while every read returned null, and the
    // cache would keep hitting.  The fix uses a discriminated outcome
    // where `uncacheable` never compares equal — not even to itself.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm cache: small models.json gets written, outcome captured as
    // `{ kind: "hashed", hash: <H> }`.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Make models.json oversize externally.  Cache-hit predicate must
    // see `{ uncacheable }` for the current outcome and force a
    // re-plan even though the captured outcome was `{ hashed, H }`.
    const modelsPath = path.join(agentDir, "models.json");
    await fs.writeFile(modelsPath, "x".repeat(2 * 1024 * 1024)); // > MAX_MODELS_JSON_BYTES (1 MiB)
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
  }, 30_000);

  // --- Generated plugin catalog sidecar drift (Codex P1 on PR #90741) ---
  //
  // The cache entry validates BOTH root models.json AND the generated plugin
  // model catalog sidecars (`plugins/<plugin>/catalog.json`) that the planner
  // owns and `ModelRegistry` later consumes.  Before the fix the warm-cache
  // hit only re-read root models.json, so a sidecar created / mutated /
  // deleted after a warm entry was cached would still hit the cache and skip
  // the reconciliation that should rewrite or remove it.  Each test below
  // would fail (cache hit, call count unchanged) under the buggy code.

  function generatedCatalogPath(agentDir: string, pluginId: string): string {
    return path.join(agentDir, encodePluginModelCatalogRelativePath(pluginId));
  }

  function generatedCatalogContents(providerBaseUrl: string): string {
    // A minimal but valid generated-marker catalog.  `generatedBy` is what
    // `isGeneratedPluginModelCatalog` keys on; `providers` is what
    // `ModelRegistry.loadCustomModels` would later consume.
    return JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        "plugin-owned-provider": {
          baseUrl: providerBaseUrl,
          api: "openai-completions",
          models: [],
        },
      },
    });
  }

  it("invalidates the cache + reconciles when a rogue generated plugin catalog sidecar appears after warm (Codex P1 #90741)", async () => {
    // The canonical exploit from the durable review: warm the cache, then drop
    // (or tamper) a generated plugin catalog sidecar that `ModelRegistry`
    // consumes, WITHOUT changing root models.json.  Under the buggy code the
    // warm hit re-read only models.json, so the rogue sidecar survived and was
    // consumed by model/provider resolution.  With the fix the sidecar outcome
    // no longer matches the captured `absent`, the cache misses, and the
    // re-plan's reconciliation (`removeStalePluginCatalogs`) deletes the rogue
    // file — proving the reconciliation the cache was skipping actually runs.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm cache with no sidecars: pluginCatalogsOutcome captured as `absent`.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // External actor plants a tampered generated catalog (attacker-controlled
    // provider transport) next to models.json.
    const sidecarPath = generatedCatalogPath(agentDir, "acme-plugin");
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, generatedCatalogContents("https://attacker.example/v1"));

    // Next call must re-plan (cache miss) AND reconcile away the rogue sidecar.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
    await expect(fs.access(sidecarPath)).rejects.toThrow(); // reconciliation removed it

    // And the now-reconciled steady state (no sidecars) hits the cache again.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
  }, 30_000);

  it("re-busts the cache on every rogue sidecar that reappears between calls (Codex P1 #90741)", async () => {
    // A persistent attacker who re-plants the rogue sidecar after each
    // reconciliation must trigger a re-plan EACH time — the warm hit can never
    // ride past a freshly-planted sidecar.  This pins the fail-closed contract
    // across repeated drift, not just the first occurrence.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();
    const sidecarPath = generatedCatalogPath(agentDir, "acme-plugin");

    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, generatedCatalogContents("https://attacker.example/v1"));
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);

    // Re-plant a DIFFERENT rogue sidecar; must re-plan again.
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, generatedCatalogContents("https://attacker-2.example/v1"));
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(3);
  }, 30_000);

  it("does not create/register the agent SQLite DB for a fingerprint-only read when no auth store exists (Codex P2 #90741)", async () => {
    // The auth-profile fingerprint feeds the cache key, so it runs on EVERY
    // call — including no-auth / skip / noop calls.  Before the fix it routed
    // through `openAuthProfileDatabase`, which `mkdirSync`s the agent dir,
    // creates the schema, and registers the DB in the shared pool — a write
    // side effect for a read-only cache-key computation.  The fix uses the
    // no-create, read-only path: with no auth store on disk, the agent SQLite
    // file must NOT be materialized merely by computing the fingerprint.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    const authDbPath = resolveAuthProfileDatabasePath(agentDir);
    // Sanity: no auth DB seeded for this case.
    await expect(fs.access(authDbPath)).rejects.toThrow();

    await ensureOpenClawModelsJson(cfg, agentDir);

    // The fingerprint read must not have created the agent auth database
    // (nor its WAL/SHM sidecars) just to decide cache usability.
    await expect(fs.access(authDbPath)).rejects.toThrow();
    await expect(fs.access(`${authDbPath}-wal`)).rejects.toThrow();
    await expect(fs.access(`${authDbPath}-shm`)).rejects.toThrow();
  }, 30_000);

  it("still hits the cache when no generated plugin catalog sidecars exist (Codex P1 #90741)", async () => {
    // Counterpart guard: the new validation must NOT spuriously bust the cache
    // in the common no-sidecar steady state.  Otherwise we'd trade a security
    // hole for a perf regression that defeats the PR's whole purpose.  Two
    // `absent` sidecar outcomes compare equal — a valid stable hit.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;

    await ensureOpenClawModelsJson(cfg, agentDir);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(firstCount);
  }, 30_000);
});
