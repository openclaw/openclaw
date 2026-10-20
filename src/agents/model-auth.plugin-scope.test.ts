import { afterEach, expect, it as baseIt, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as metadataScope from "../plugins/current-plugin-metadata-snapshot.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as authority from "../plugins/provider-auth-authority.js";
import { createProviderAuthAvailability } from "../plugins/provider-auth-availability-core.js";
import type { ProviderSyntheticAuthResult } from "../plugins/provider-external-auth.types.js";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import * as providerRuntime from "../plugins/provider-runtime.js";
import { restorePreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationRegistryScope } from "../plugins/runtime/generation-state.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { getPreparedPluginSecretInput } from "../secrets/prepared-plugin-input.js";
import * as secrets from "../secrets/runtime-state.js";
import * as snapshots from "./auth-profiles/runtime-snapshots.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import * as authModel from "./model-auth-model.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
import * as authRuntime from "./model-auth-runtime.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

// mock-isolation: Replace the native loading bridge; keep real selection, instance, auth and secrets owners.
vi.mock("../plugins/provider-hook-runtime.js", async () => {
  const { createProviderHookRuntime } = await import("../plugins/provider-hook-runtime-core.js");
  const { createProviderRegistryResolver } = await import("../plugins/providers.runtime-core.js");
  return createProviderHookRuntime(
    createProviderRegistryResolver({
      loadOpenClawPlugins: () => {
        throw new Error("cold plugin load");
      },
      resolveRuntimePluginRegistry: () => undefined,
      isPluginRegistryLoadInFlight: () => false,
    }),
  );
});

const id = "credential-fixture";
const pluginAuth = { apiKey: "resolved-plugin-key", source: "plugin:fixture" };
const staleAuth = { apiKey: "stale-key", mode: "api-key" as const, source: "stale" };
const noWebProvider = { providerSource: "none" as const, diagnostics: [] };
const modelProvider = { baseUrl: "http://127.0.0.1:8080", apiKey: "models-key", models: [] };
const unrelatedKey = { source: "env" as const, provider: "default", id: "UNRELATED_KEY" };
const missingAuth = { code: "missing-provider-auth" };
const retiredCredential = "credential owner was retired or replaced";
const entry: ModelCatalogEntry = { id: "decision", name: "Decision", provider: id };
const store = {
  version: 1,
  profiles: { [id + ":implicit"]: { type: "api_key" as const, provider: id, key: "agent-key" } },
};
const instances: PluginInstance[] = [];
afterEach(async () => {
  secrets.clearSecretsRuntimeSnapshotState();
  for (const instance of instances.splice(0)) {
    await instance.dispose();
  }
});

function pluginConfig(pluginSecretRef: unknown, enabled = true) {
  return { entries: { [id]: { enabled, config: { pluginSecretRef } } } };
}

function metadataFixture(owner = id, authScope: "agent" | "plugin" = "plugin") {
  const modelCatalog = { providers: { [id]: { authScope, models: [] } } };
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: owner, providers: [id], modelCatalog }],
  });
}

function fixture(
  options: {
    wrapped?: boolean;
    missing?: boolean;
    disabled?: boolean;
    scope?: "agent" | "plugin";
    runtimeScope?: "agent" | "plugin";
    active?: boolean;
    runtimeAuth?: ProviderPlugin["prepareRuntimeAuth"];
    provider?: Partial<ModelProviderConfig>;
  } = {},
) {
  const cfg: OpenClawConfig = {
    plugins: pluginConfig(pluginAuth.apiKey, !options.disabled),
    models: { providers: { [id]: { ...modelProvider, ...options.provider } } },
  };
  const metadata = metadataFixture(id, options.scope);
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  const instance = new PluginInstance(id, { record, registry });
  instances.push(instance);
  const hook = vi.fn((): ProviderSyntheticAuthResult | undefined => {
    const input = getPreparedPluginSecretInput(id, "pluginSecretRef");
    return input.value
      ? { apiKey: input.value, mode: "api-key", source: "plugin:fixture" }
      : undefined;
  });
  const prepare = vi.fn(async () => staleAuth);
  const definition = {
    id,
    label: id,
    pluginId: id,
    auth: [],
    authScope: options.runtimeScope ?? "plugin",
    resolveSyntheticAuth: hook,
    prepareSyntheticAuth: prepare,
    prepareRuntimeAuth: options.runtimeAuth,
  } satisfies ProviderPlugin;
  const provider = options.wrapped ? instance.wrap(definition) : instance.adopt(definition);
  if (!options.missing && !options.disabled) {
    registry.providers.push({ pluginId: id, provider, source: record.source });
  }
  const run = <T>(fn: () => T): T =>
    metadataScope.withPluginMetadataSnapshotScope(
      metadata,
      () => withPluginRuntimeGenerationRegistryScope(registry, fn),
      { config: cfg, trustConfigIdentity: true },
    );
  const activate = () =>
    secrets.activateSecretsRuntimeSnapshotState({
      snapshot: {
        sourceConfig: {
          plugins: pluginConfig({ source: "store", provider: "default", id: "FIXTURE_KEY" }),
        },
        config: cfg,
        authStores: [],
        warnings: [],
        authStoreCredentialsRevision: snapshots.getRuntimeAuthProfileStoreCredentialsRevision(),
        authStoreSnapshotsRevision: snapshots.getRuntimeAuthProfileStoreSnapshotsRevision(),
        webTools: { search: noWebProvider, fetch: noWebProvider, diagnostics: [] },
      },
      refreshContext: {
        env: {},
        explicitAgentDirs: [],
        includeConfigRefs: true,
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      },
      refreshHandler: null,
    });
  const params = { provider: id, cfg, store };
  const lookup = { provider: id, config: cfg, context: { provider: id, config: cfg } };
  const plan = { provider: id, modelId: "fixture-model", config: cfg, metadataSnapshot: metadata };
  return { cfg, metadata, registry, instance, run, activate, params, lookup, hook, prepare, plan };
}

function project(
  f: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof createModelCatalogDecisions>[0]> = {},
) {
  return createModelCatalogDecisions({
    cfg: f.cfg,
    agentId: "main",
    snapshot: { entries: [entry], routeVariants: [entry] },
    metadataSnapshot: f.metadata,
    preparedAuthStore: store,
    pluginRegistry: f.registry,
    isCurrent: () => true,
    ...overrides,
  });
}

type FixtureOptions = Parameters<typeof fixture>[0];
type Fixture = ReturnType<typeof fixture>;
type Check = (f: Fixture) => unknown;
type Scenario<T> = (value: T, f: Fixture) => unknown;
type Configure<T> = (value: T) => FixtureOptions;
async function inFixture(run: Check, options: FixtureOptions = {}) {
  const f = fixture(options);
  if (options.active !== false) {
    f.activate();
  }
  await f.run(() => run(f));
}
function test(name: string, run: Check, options: FixtureOptions = {}) {
  baseIt(name, () => inFixture(run, options));
}
test.each =
  <T>(cases: readonly T[]) =>
  (name: string, run: Scenario<T>, options: Configure<T> = () => ({})) =>
    baseIt.for(cases)(name, (value) => inFixture((f) => run(value, f), options(value)));

baseIt("plans plugin-owned auth before agent stores, configured bindings and cooldowns", () => {
  const f = fixture();
  const readProfiles = vi.fn(() => {
    throw new Error("agent store must remain untouched");
  });
  const prepared = prepareAgentRuntimeAuth({
    ...f.plan,
    config: { ...f.cfg, auth: { order: { [id]: [id + ":implicit"] } } },
    authProfileStore: {
      version: 1,
      get profiles() {
        return readProfiles();
      },
    },
  });
  expect(prepared.attempts).toEqual([
    {
      kind: "direct",
      plan: prepared.plan,
      allowAuthProfileFallback: false,
      requiresPriorProfileAttempt: false,
    },
  ]);
  expect(prepared.plan).toMatchObject({
    providerForAuth: id,
    modelId: "fixture-model",
    credentialSource: { kind: "direct", evidence: "synthetic", authorization: "declared" },
    forwardedAuthProfileId: undefined,
    forwardedAuthProfileCandidateIds: undefined,
  });
  expect(readProfiles).not.toHaveBeenCalled();
  expect(f.hook).not.toHaveBeenCalled();
});

baseIt.each(["requiredAuthProfileId", "sessionAuthProfileId"] as const)(
  "rejects an explicit %s while planning plugin-owned auth",
  (pin) => {
    const f = fixture();
    expect(() =>
      prepareAgentRuntimeAuth({
        ...f.plan,
        [pin]: id + ":implicit",
        sessionAuthProfileSource: "auto",
      }),
    ).toThrow("profile pins");
    expect(f.hook).not.toHaveBeenCalled();
  },
);

test("uses prepared metadata ownership over ambient declarations", async (f) => {
  const modelPolicy = await import("./model-auth-policy.js");
  const policy = vi.spyOn(modelPolicy, "isAuthModeAllowedForModel").mockImplementation(
    () =>
      metadataScope.getCurrentPluginMetadataSnapshot({
        config: f.cfg,
        allowScopedSnapshot: true,
        allowWorkspaceScopedSnapshot: true,
      }) === f.metadata,
  );
  try {
    metadataScope.withPluginMetadataSnapshotScope(
      metadataFixture("foreign-owner"),
      () => expect(project(f).evaluateEntry(entry)).toMatchObject({ availability: true }),
      { config: f.cfg, trustConfigIdentity: true },
    );
    expect(f.hook).toHaveBeenCalled();
  } finally {
    policy.mockRestore();
  }
});

test.each([false, true])(
  "rejects quiescence during result property reads (registration wrapping: %s)",
  async (_wrapped, f) => {
    f.hook.mockImplementation(() => ({
      get apiKey() {
        f.instance.quiesce();
        return "synthetic-not-a-credential";
      },
      mode: "api-key",
      source: "fixture",
    }));
    await expect(resolveApiKeyForProviderCore(f.params)).rejects.toThrow();
  },
  (wrapped) => ({ wrapped }),
);

test.each([
  { prepared: "empty", ambient: "live", expected: false },
  { prepared: "absent", ambient: "live", expected: undefined },
  { prepared: "live", ambient: "empty", expected: true },
] as const)(
  "binds catalog readiness to prepared $prepared, not ambient $ambient",
  async ({ prepared, ambient, expected }, f) => {
    const empty = createEmptyPluginRegistry();
    await withPluginRuntimeGenerationRegistryScope(
      ambient === "live" ? f.registry : empty,
      async () => {
        const projection = project(f, {
          pluginRegistry:
            prepared === "absent" ? undefined : prepared === "live" ? f.registry : empty,
        });
        expect(projection.evaluateEntry(entry).availability).toBe(expected);
        if (prepared !== "live") {
          expect(f.hook).not.toHaveBeenCalled();
        }
      },
    );
  },
);

test("invalidates catalog readiness on revocation", async (f) => {
  const projection = project(f);
  const ready = projection.evaluateEntry(entry);
  expect(ready).toMatchObject({ availability: true, selectedAuthMode: "api-key" });
  secrets.clearSecretsRuntimeSnapshotState();
  expect(projection.isCurrent()).toBe(false);
  const unavailable = projection.evaluateEntry(entry);
  expect(unavailable).toMatchObject({ availability: false, unavailableReason: "missing-auth" });
});

test.each(["native", "no-auth"])(
  "keeps %s marker eligibility scoped to its owner",
  async (kind, f) => {
    const native = kind === "native";
    const result: ProviderSyntheticAuthResult = {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      mode: native ? "oauth" : "api-key",
      source: native ? "plugin:native" : "local-no-auth",
      ...(native ? { nativeAuth: { runtime: "native-fixture", mode: "oauth" as const } } : {}),
    };
    f.hook.mockImplementation(() => result);
    if (native) {
      const projection = project(f);
      expect(projection.evaluateEntry(entry, undefined, "other-runtime").availability).toBe(false);
      expect(projection.evaluateEntry(entry, undefined, "native-fixture")).toMatchObject({
        availability: true,
        runtimeAuth: { id: "native-fixture", source: "native" },
        selectedCredential: { source: "harness" },
      });
      await expect(resolveApiKeyForProviderCore(f.params)).rejects.toMatchObject({
        ...missingAuth,
        provider: id,
      });
    } else {
      expect(await resolveApiKeyForProviderCore(f.params)).toMatchObject(result);
      expect(authRuntime.hasRuntimeAvailableProviderAuth(f.params)).toBe(true);
    }
    expect(f.prepare).not.toHaveBeenCalled();
  },
  () => ({ active: false }),
);

test("refuses catalog profile pins before reading plugin credentials", async (f) => {
  const projection = project(f, { pinnedProfileId: id + ":implicit", profileProvider: id });
  expect(projection.evaluateEntry(entry)).toMatchObject({ availability: false });
  expect(f.hook).not.toHaveBeenCalled();
});

test("keeps protected credentials opaque until provider egress", async (f) => {
  const { unwrapSecretSentinelsForProviderEgress } = await import("./provider-secret-egress.js");
  const { apiKey } = await resolveApiKeyForProviderCore({ ...f.params, secretSentinels: true });
  expect(apiKey).toBeDefined();
  expect(apiKey).not.toBe(pluginAuth.apiKey);
  expect(unwrapSecretSentinelsForProviderEgress(apiKey!, "test egress")).toBe(pluginAuth.apiKey);
});

test("checks SDK availability without reading agent storage", async (f) => {
  const readAgentStore = vi.fn(() => {
    throw new Error("agent storage must not be read");
  });
  const { isProviderApiKeyConfiguredAsync: configured } = createProviderAuthAvailability(
    {
      ensureAuthProfileStore: readAgentStore,
      ensureAuthProfileStoreAsync: readAgentStore,
      loadAuthProfileStoreWithoutExternalProfilesAsync: readAgentStore,
      loadAuthProfileStoreForRuntimeAsync: readAgentStore,
      findPersistedAuthProfileCredential: readAgentStore,
      findPersistedAuthProfileCredentialAsync: readAgentStore,
      loadAuthProfileStoreForSecretsRuntime: readAgentStore,
      loadAuthProfileStoreWithoutExternalProfiles: readAgentStore,
    },
    resolveLoadedProviderRuntimePlugin,
  );
  const params = { provider: id, cfg: f.cfg };
  expect(await configured(params)).toBe(true);
  expect(await configured({ ...params, profileTypes: ["oauth"] })).toBe(false);
  const acceptsApiKey = (key: string) => key === pluginAuth.apiKey;
  expect(await configured({ ...params, acceptsApiKey })).toBe(true);
  secrets.clearSecretsRuntimeSnapshotState();
  expect(await configured(params)).toBe(false);
  expect(readAgentStore).not.toHaveBeenCalled();
});

test.each([false, true])(
  "keeps plugin ownership ahead of agent no-auth config when the runtime is missing: %s",
  async (missing, f) => {
    const auth = authRuntime.prepareSyntheticLocalProviderAuth(f.params);
    if (missing) {
      await expect(auth).rejects.toThrow();
    } else {
      await expect(auth).resolves.toMatchObject(pluginAuth);
    }
    expect(f.prepare).not.toHaveBeenCalled();
  },
  (missing) => ({ missing, provider: { auth: "none", api: "openai-completions" } }),
);

test("does not read a live credential after preparation is cancelled", async (f) => {
  await expect(
    authRuntime.prepareRuntimeAvailableProviderAuth({ ...f.params, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(f.hook).not.toHaveBeenCalled();
});

test(
  "resolves sync and async auth modes before agent profiles",
  async (f) => {
    f.hook.mockReturnValue({ apiKey: "live-token", mode: "token", source: "plugin:fixture" });
    expect(authModel.resolveModelAuthMode(id, f.cfg, store)).toBe("token");
    expect(await authModel.resolveModelAuthModeAsync(id, f.cfg, store)).toBe("token");
    await f.instance.dispose();
    expect(authModel.resolveModelAuthMode(id, f.cfg, store)).toBe("unknown");
    expect(await authModel.resolveModelAuthModeAsync(id, f.cfg, store)).toBe("unknown");
  },
  { active: false },
);

test.each(["literal", "SecretRef"])(
  "uses plugin auth over %s model keys and saved facts",
  async (_keyKind, f) => {
    restorePreparedSyntheticAuthFacts(f.cfg, [{ providerRef: id, result: staleAuth }]);
    expect(await resolveApiKeyForProviderCore(f.params)).toMatchObject(pluginAuth);
    expect(authRuntime.hasRuntimeAvailableProviderAuth(f.params)).toBe(true);
    expect(await authRuntime.prepareRuntimeAvailableProviderAuth(f.params)).toBe(true);
    expect(await authModel.hasAvailableAuthForProvider(f.params)).toBe(true);
    expect(await providerRuntime.prepareProviderSyntheticAuthWithPlugin(f.lookup)).toMatchObject(
      pluginAuth,
    );
    const facts = await providerRuntime.captureProviderSyntheticAuthFacts({
      config: f.cfg,
      providerRefs: [id],
    });
    expect(facts).toEqual([]);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.hook).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: undefined }));
  },
  (kind) => ({
    provider: { apiKey: kind === "SecretRef" ? unrelatedKey : modelProvider.apiKey },
  }),
);

test.each(["profileId", "preferredProfile"] as const)(
  "rejects %s before invoking plugin auth",
  async (pin, f) => {
    await expect(
      resolveApiKeyForProviderCore({ ...f.params, [pin]: id + ":implicit" }),
    ).rejects.toThrow("profile pins");
    expect(f.hook).not.toHaveBeenCalled();
  },
);

test.each(["missing", "disabled", "retired", "disabled-instance"] as const)(
  "never falls back for a %s selected provider",
  async (state, f) => {
    if (state === "retired") {
      await f.instance.dispose();
    }
    if (state === "disabled-instance") {
      f.instance.owner!.record.enabled = false;
    }
    await expect(resolveApiKeyForProviderCore(f.params)).rejects.toMatchObject(missingAuth);
    expect(() => authRuntime.hasRuntimeAvailableProviderAuth(f.params)).toThrow();
    await expect(authRuntime.prepareRuntimeAvailableProviderAuth(f.params)).rejects.toThrow();
    expect(await authModel.hasAvailableAuthForProvider(f.params)).toBe(false);
    expect(f.hook).not.toHaveBeenCalled();
  },
  (state) => ({ missing: state === "missing", disabled: state === "disabled" }),
);

test("refuses revoked protected secret input rather than reusing a prior bearer", async (f) => {
  expect(await resolveApiKeyForProviderCore(f.params)).toMatchObject(pluginAuth);
  secrets.clearSecretsRuntimeSnapshotState();
  await expect(resolveApiKeyForProviderCore(f.params)).rejects.toMatchObject(missingAuth);
  expect(await authModel.hasAvailableAuthForProvider(f.params)).toBe(false);
});

test.each(["hook", "secret"])(
  "rejects %s authority replacement during auth",
  (owner, f) => {
    f.hook.mockImplementation(() => {
      if (owner === "hook") {
        f.registry.providers[0]!.provider = {
          ...f.registry.providers[0]!.provider,
          resolveSyntheticAuth: () => ({ apiKey: "new", mode: "api-key", source: "new" }),
        };
      } else {
        secrets.clearSecretsRuntimeSnapshotState();
      }
      return { apiKey: "obsolete", mode: "api-key", source: "obsolete" };
    });
    if (owner === "secret") {
      f.activate();
    }
    expect(() => providerRuntime.resolveProviderSyntheticAuthWithPlugin(f.lookup)).toThrow(
      "retired or replaced",
    );
  },
  () => ({ active: false }),
);

baseIt.each([false, true])(
  "retains credential authority through an awaited exchange (revoked during exchange: %s)",
  async (revokeDuringExchange) => {
    const entered = createDeferred();
    const exchanged = createDeferred<{ apiKey: string }>();
    const f = fixture({
      runtimeAuth: async () => {
        entered.resolve();
        return await exchanged.promise;
      },
    });
    f.activate();
    await f.run(async () => {
      const auth = await resolveApiKeyForProviderCore(f.params);
      if (!auth.apiKey) {
        throw new Error("Missing fixture plugin credential");
      }
      const model = authority.attachProviderAuthAuthority(
        makeProviderModelFixture({
          provider: id,
          id: "fixture-model",
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
        }),
        authority.getProviderAuthAuthority(auth),
      );
      const pending = providerRuntime.prepareProviderRuntimeAuth({
        provider: id,
        config: f.cfg,
        context: {
          env: process.env,
          provider: id,
          modelId: model.id,
          model,
          apiKey: auth.apiKey,
          authMode: auth.mode,
        },
      });
      await entered.promise;
      if (revokeDuringExchange) {
        secrets.clearSecretsRuntimeSnapshotState();
      }
      exchanged.resolve({ apiKey: "exchanged-key" });
      if (revokeDuringExchange) {
        await expect(pending).rejects.toThrow(retiredCredential);
      } else {
        const prepared = await pending;
        expect(prepared?.apiKey).toBe("exchanged-key");
        expect(() => authority.assertProviderAuthAuthority(prepared)).not.toThrow();
        secrets.clearSecretsRuntimeSnapshotState();
        expect(() => authority.assertProviderAuthAuthority(prepared)).toThrow(retiredCredential);
      }
    });
  },
);

test.each([
  ["plugin", "agent"],
  ["agent", "plugin"],
] as const)(
  "refuses static/runtime scope mismatch: %j",
  (_scopes, f) => {
    expect(() => providerRuntime.resolveProviderSyntheticAuthWithPlugin(f.lookup)).toThrow();
    expect(f.hook).not.toHaveBeenCalled();
  },
  ([scope, runtimeScope]) => ({ scope, runtimeScope, active: false }),
);
