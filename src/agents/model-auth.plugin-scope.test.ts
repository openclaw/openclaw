import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  resolveProviderSyntheticAuthWithPlugin,
  prepareProviderSyntheticAuthWithPlugin,
  captureProviderSyntheticAuthFacts,
} from "../plugins/provider-runtime.js";
import { restorePreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationRegistryScope } from "../plugins/runtime/generation-state.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { getPreparedPluginSecretInput } from "../secrets/prepared-plugin-input.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "../secrets/runtime-state.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "./auth-profiles/runtime-snapshots.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import { hasAvailableAuthForProvider } from "./model-auth-model.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
import {
  hasRuntimeAvailableProviderAuth,
  prepareRuntimeAvailableProviderAuth,
} from "./model-auth-runtime.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

// Replace only the native loading bridge, not selection, instance, auth or secrets owners.
vi.mock("../plugins/provider-hook-runtime.js", async () => {
  const { createProviderHookRuntime } = await import("../plugins/provider-hook-runtime-core.js");
  const { createProviderRegistryResolver } = await import("../plugins/providers.runtime-core.js");
  const hooks = createProviderHookRuntime(
    createProviderRegistryResolver({
      loadOpenClawPlugins: () => {
        throw new Error("cold plugin load");
      },
      resolveRuntimePluginRegistry: () => undefined,
      isPluginRegistryLoadInFlight: () => false,
    }),
  );
  return hooks;
});

const id = "credential-fixture";
const store = {
  version: 1,
  profiles: { [id + ":implicit"]: { type: "api_key" as const, provider: id, key: "agent-key" } },
};
const instances: PluginInstance[] = [];
afterEach(async () => {
  clearSecretsRuntimeSnapshotState();
  for (const instance of instances.splice(0)) {
    await instance.dispose();
  }
});

function fixture(
  options: {
    wrapped?: boolean;
    missing?: boolean;
    disabled?: boolean;
    scope?: "agent" | "plugin";
    runtimeScope?: "agent" | "plugin";
    hook?: ProviderPlugin["resolveSyntheticAuth"];
  } = {},
) {
  const cfg: OpenClawConfig = {
    plugins: {
      entries: {
        [id]: { enabled: !options.disabled, config: { pluginSecretRef: "resolved-plugin-key" } },
      },
    },
    models: {
      providers: { [id]: { baseUrl: "http://127.0.0.1:8080", apiKey: "models-key", models: [] } },
    },
  };
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id,
        providers: [id],
        modelCatalog: { providers: { [id]: { authScope: options.scope ?? "plugin", models: [] } } },
      },
    ],
  });
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  const instance = new PluginInstance(id, { record, registry });
  instances.push(instance);
  const hook = vi.fn(
    options.hook ??
      (() => {
        const input = getPreparedPluginSecretInput(id, "pluginSecretRef");
        return input.value
          ? { apiKey: input.value, mode: "api-key" as const, source: "plugin:fixture" }
          : undefined;
      }),
  );
  const prepare = vi.fn(async () => ({
    apiKey: "cached-key",
    mode: "api-key" as const,
    source: "cache",
  }));
  const definition = {
    id,
    label: id,
    pluginId: id,
    auth: [],
    authScope: options.runtimeScope ?? "plugin",
    resolveSyntheticAuth: hook,
    prepareSyntheticAuth: prepare,
  } satisfies ProviderPlugin;
  const provider = options.wrapped ? instance.wrap(definition) : instance.adopt(definition);
  if (!options.missing && !options.disabled) {
    registry.providers.push({ pluginId: id, provider, source: record.source });
  }
  const run = <T>(fn: () => T): T =>
    withPluginMetadataSnapshotScope(
      metadata,
      () => withPluginRuntimeGenerationRegistryScope(registry, fn),
      { config: cfg, trustConfigIdentity: true },
    );
  const activate = () =>
    activateSecretsRuntimeSnapshotState({
      snapshot: {
        sourceConfig: {
          plugins: {
            entries: {
              [id]: {
                enabled: true,
                config: {
                  pluginSecretRef: { source: "store", provider: "default", id: "FIXTURE_KEY" },
                },
              },
            },
          },
        },
        config: cfg,
        authStores: [],
        warnings: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
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
  return { cfg, metadata, registry, instance, run, activate, params, lookup, hook, prepare };
}

describe("plugin physical credential ownership through common auth", () => {
  it("uses prepared metadata ownership instead of an unrelated ambient declaration", async () => {
    const f = fixture();
    f.activate();
    const foreign = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "foreign-owner",
          providers: [id],
          modelCatalog: { providers: { [id]: { authScope: "plugin", models: [] } } },
        },
      ],
    });
    const entry: ModelCatalogEntry = { id: "decision", name: "Decision", provider: id };
    await f.run(() =>
      withPluginMetadataSnapshotScope(
        foreign,
        async () => {
          const projection = createModelCatalogDecisions({
            cfg: f.cfg,
            agentId: "main",
            snapshot: { entries: [entry], routeVariants: [entry] },
            metadataSnapshot: f.metadata,
            preparedAuthStore: store,
            pluginRegistry: f.registry,
            isCurrent: () => true,
          });
          expect(await projection.evaluateEntry(entry)).toMatchObject({ availability: true });
        },
        { config: f.cfg, trustConfigIdentity: true },
      ),
    );
    expect(f.hook).toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects quiescence during result property reads (registration wrapping: %s)",
    async (wrapped) => {
      let quiesce = () => {};
      const f = fixture({
        wrapped,
        hook: () => ({
          get apiKey() {
            quiesce();
            return "synthetic-not-a-credential";
          },
          mode: "api-key",
          source: "fixture",
        }),
      });
      quiesce = () => {
        f.instance.quiesce();
      };
      f.activate();
      await f.run(() => expect(resolveApiKeyForProviderCore(f.params)).rejects.toThrow());
    },
  );

  it.each([
    { prepared: "empty", ambient: "live", expected: false },
    { prepared: "absent", ambient: "live", expected: undefined },
    { prepared: "live", ambient: "empty", expected: true },
  ] as const)(
    "binds catalog readiness to prepared $prepared instead of ambient $ambient",
    async ({ prepared, ambient, expected }) => {
      const f = fixture();
      f.activate();
      const empty = createEmptyPluginRegistry();
      const entry: ModelCatalogEntry = {
        id: "decision",
        name: "Decision",
        provider: id,
        inference: { chat: false },
      };
      await f.run(() =>
        withPluginRuntimeGenerationRegistryScope(
          ambient === "live" ? f.registry : empty,
          async () => {
            const projection = createModelCatalogDecisions({
              cfg: f.cfg,
              agentId: "main",
              snapshot: { entries: [entry], routeVariants: [entry] },
              metadataSnapshot: f.metadata,
              preparedAuthStore: store,
              ...(prepared === "absent"
                ? {}
                : { pluginRegistry: prepared === "live" ? f.registry : empty }),
              isCurrent: () => true,
            });
            const evaluation = await projection.evaluateEntry(entry);
            expect(evaluation.availability).toBe(expected);
            if (prepared !== "live") {
              expect(f.hook).not.toHaveBeenCalled();
            }
          },
        ),
      );
    },
  );

  it("projects live plugin readiness without profile fallback or a stale positive cache", async () => {
    const f = fixture();
    f.activate();
    const entry: ModelCatalogEntry = {
      id: "decision",
      name: "Decision",
      provider: id,
      inference: {
        chat: false,
        decision: {
          protocol: "fixture",
          input: ["text"],
          questions: { boolean: { probabilities: "boolean", abstention: false } },
        },
      },
    };
    await f.run(async () => {
      const projection = createModelCatalogDecisions({
        cfg: f.cfg,
        agentId: "main",
        snapshot: { entries: [entry], routeVariants: [entry] },
        metadataSnapshot: f.metadata,
        preparedAuthStore: store,
        pluginRegistry: f.registry,
        isCurrent: () => true,
      });
      expect(await projection.evaluateEntry(entry)).toMatchObject({
        availability: true,
        selectedAuthMode: "api-key",
      });
      clearSecretsRuntimeSnapshotState();
      expect(projection.isCurrent()).toBe(false);
      expect(await projection.evaluateEntry(entry)).toMatchObject({
        availability: false,
        unavailableReason: "missing-auth",
      });
    });
  });

  it("refuses a catalog account pin before reading the protected plugin credential", async () => {
    const f = fixture();
    f.activate();
    const entry: ModelCatalogEntry = {
      id: "decision",
      name: "Decision",
      provider: id,
      inference: { chat: false },
    };
    await f.run(async () => {
      const projection = createModelCatalogDecisions({
        cfg: f.cfg,
        agentId: "main",
        snapshot: { entries: [entry], routeVariants: [entry] },
        metadataSnapshot: f.metadata,
        preparedAuthStore: store,
        pluginRegistry: f.registry,
        pinnedProfileId: id + ":implicit",
        profileProvider: id,
        isCurrent: () => true,
      });
      expect(await projection.evaluateEntry(entry)).toMatchObject({ availability: false });
    });
    expect(f.hook).not.toHaveBeenCalled();
  });

  it("keeps a prepared protected credential opaque until the normal provider egress boundary", async () => {
    const f = fixture();
    f.activate();
    const { unwrapSecretSentinelsForProviderEgress } = await import("./provider-secret-egress.js");
    const auth = await f.run(() =>
      resolveApiKeyForProviderCore({ ...f.params, secretSentinels: true }),
    );
    expect(auth.apiKey).toBeDefined();
    expect(auth.apiKey).not.toBe("resolved-plugin-key");
    expect(unwrapSecretSentinelsForProviderEgress(auth.apiKey!, "synthetic test boundary")).toBe(
      "resolved-plugin-key",
    );
  });

  it("uses the live protected owner, not implicit profiles, models keys, prepare hooks or restored bearer facts", async () => {
    const f = fixture();
    f.activate();
    restorePreparedSyntheticAuthFacts(f.cfg, [
      { providerRef: id, result: { apiKey: "restored-key", mode: "api-key", source: "restored" } },
    ]);
    await f.run(async () => {
      expect(await resolveApiKeyForProviderCore(f.params)).toMatchObject({
        apiKey: "resolved-plugin-key",
        source: "plugin:fixture",
      });
      expect(hasRuntimeAvailableProviderAuth(f.params)).toBe(true);
      expect(await prepareRuntimeAvailableProviderAuth(f.params)).toBe(true);
      expect(await hasAvailableAuthForProvider(f.params)).toBe(true);
      expect(await prepareProviderSyntheticAuthWithPlugin(f.lookup)).toMatchObject({
        apiKey: "resolved-plugin-key",
      });
      expect(
        await captureProviderSyntheticAuthFacts({ config: f.cfg, providerRefs: [id] }),
      ).toEqual([]);
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.hook).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: undefined }));
  });

  it.each(["profileId", "preferredProfile"] as const)(
    "rejects %s before invoking plugin auth",
    async (pin) => {
      const f = fixture();
      f.activate();
      await f.run(() =>
        expect(
          resolveApiKeyForProviderCore({ ...f.params, [pin]: id + ":implicit" }),
        ).rejects.toThrow("profile pins"),
      );
      expect(f.hook).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "disabled", "retired"] as const)(
    "never falls back for a %s selected provider",
    async (state) => {
      const f = fixture({ missing: state === "missing", disabled: state === "disabled" });
      f.activate();
      if (state === "retired") {
        await f.instance.dispose();
      }
      await f.run(async () => {
        await expect(resolveApiKeyForProviderCore(f.params)).rejects.toMatchObject({
          code: "missing-provider-auth",
        });
        expect(() => hasRuntimeAvailableProviderAuth(f.params)).toThrow();
        await expect(prepareRuntimeAvailableProviderAuth(f.params)).rejects.toThrow();
        expect(await hasAvailableAuthForProvider(f.params)).toBe(false);
      });
      expect(f.hook).not.toHaveBeenCalled();
    },
  );

  it("refuses revoked protected secret input rather than reusing a prior bearer", async () => {
    const f = fixture();
    f.activate();
    await f.run(async () => {
      expect(await resolveApiKeyForProviderCore(f.params)).toMatchObject({
        apiKey: "resolved-plugin-key",
      });
      clearSecretsRuntimeSnapshotState();
      await expect(resolveApiKeyForProviderCore(f.params)).rejects.toMatchObject({
        code: "missing-provider-auth",
      });
      expect(await hasAvailableAuthForProvider(f.params)).toBe(false);
    });
  });

  it("does not use a models.providers SecretRef as plugin credentials", async () => {
    const f = fixture();
    f.cfg.models!.providers![id]!.apiKey = {
      source: "env",
      provider: "default",
      id: "UNRELATED_KEY",
    };
    f.activate();
    await f.run(async () => {
      expect(await resolveApiKeyForProviderCore(f.params)).toMatchObject({
        apiKey: "resolved-plugin-key",
      });
      expect(hasRuntimeAvailableProviderAuth(f.params)).toBe(true);
    });
  });

  it("refuses a disabled actual instance even if a retained registry still contains its hook", async () => {
    const f = fixture();
    f.activate();
    f.instance.owner!.record.enabled = false;
    await f.run(() =>
      expect(resolveApiKeyForProviderCore(f.params)).rejects.toMatchObject({
        code: "missing-provider-auth",
      }),
    );
    expect(f.hook).not.toHaveBeenCalled();
  });

  it("rejects a hook replaced during auth instead of returning its obsolete result", () => {
    const f = fixture({
      hook: () => {
        f.registry.providers[0]!.provider = {
          ...f.registry.providers[0]!.provider,
          resolveSyntheticAuth: () => ({ apiKey: "new", mode: "api-key", source: "new" }),
        };
        return { apiKey: "obsolete", mode: "api-key", source: "obsolete" };
      },
    });
    f.run(() =>
      expect(() => resolveProviderSyntheticAuthWithPlugin(f.lookup)).toThrow("retired or replaced"),
    );
  });

  it("rejects replacement of secret authority during the synchronous hook", () => {
    const f = fixture({
      hook: () => {
        clearSecretsRuntimeSnapshotState();
        return { apiKey: "obsolete", mode: "api-key", source: "obsolete" };
      },
    });
    f.activate();
    f.run(() =>
      expect(() => resolveProviderSyntheticAuthWithPlugin(f.lookup)).toThrow("retired or replaced"),
    );
  });

  it("accepts a no-auth marker only as auth eligibility, without preparing artifacts or health", async () => {
    const f = fixture({
      hook: () => ({ apiKey: CUSTOM_LOCAL_AUTH_MARKER, mode: "api-key", source: "local-no-auth" }),
    });
    await f.run(async () => {
      expect(await resolveApiKeyForProviderCore(f.params)).toEqual({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        mode: "api-key",
        source: "local-no-auth",
      });
      expect(hasRuntimeAvailableProviderAuth(f.params)).toBe(true);
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["plugin", "agent"],
    ["agent", "plugin"],
  ] as const)("refuses static %s / runtime %s mismatch", (scope, runtimeScope) => {
    const f = fixture({ scope, runtimeScope });
    f.run(() => expect(() => resolveProviderSyntheticAuthWithPlugin(f.lookup)).toThrow());
    expect(f.hook).not.toHaveBeenCalled();
  });
});
