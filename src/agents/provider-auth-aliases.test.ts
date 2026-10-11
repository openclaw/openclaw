/**
 * Regression coverage for provider auth alias resolution.
 * Verifies plugin metadata aliases, origin priority, trust, and cache behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshotWithMetadata: vi.fn(() => ({ snapshot: { plugins: [] } })),
    resolveInstalledManifestRegistryIndexFingerprint: vi.fn(() => "test-index"),
    loadPluginMetadataSnapshot: vi.fn((params: unknown) => {
      const registry = loadManifestRegistry(params) ?? { plugins: [], diagnostics: [] };
      return createPluginMetadataSnapshot({
        plugins: registry.plugins.map(
          (plugin: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">) =>
            createPluginManifestRecord({ ...plugin, origin: plugin.origin ?? "global" }),
        ),
      });
    }),
  };
});

vi.mock("../plugins/manifest-registry-installed.js", async (importOriginal) => {
  const { selectInstalledPluginManifestRecords } =
    await importOriginal<typeof import("../plugins/manifest-registry-installed.js")>();
  return {
    selectInstalledPluginManifestRecords,
    loadPluginManifestRegistryForInstalledIndex:
      pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
    resolveInstalledManifestRegistryIndexFingerprint:
      pluginRegistryMocks.resolveInstalledManifestRegistryIndexFingerprint,
  };
});

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshotWithMetadata:
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
}));

import {
  makeEmptyPluginMetadataOwners,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { snapshotReaderSlot } from "../plugins/plugin-metadata-snapshot-readers.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveAuthProfileOrderWithMetadata } from "./auth-profiles/order.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";
import { resolveProviderAuthAliasMap, resolveProviderIdForAuth } from "./provider-auth-aliases.js";

function createPluginManifestRecord(
  plugin: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id" | "origin">,
): PluginManifestRecord {
  return {
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/plugins/${plugin.id}`,
    source: `/plugins/${plugin.id}`,
    manifestPath: `/plugins/${plugin.id}/.codex-plugin/plugin.json`,
    ...plugin,
  };
}

function createInstalledPluginIndexRecord(
  plugin: PluginManifestRecord,
): InstalledPluginIndexRecord {
  return {
    pluginId: plugin.id,
    manifestPath: plugin.manifestPath,
    manifestHash: `${plugin.id}:manifest`,
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    enabled: true,
    enabledByDefault: true,
    startup: {
      sidecar: false,
      memory: false,
      agentHarnesses: [],
    },
    compat: [],
  };
}

function createPluginMetadataSnapshot(params: {
  config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
  plugins: readonly PluginManifestRecord[];
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 1,
    installRecords: {},
    plugins: params.plugins.map((plugin) => createInstalledPluginIndexRecord(plugin)),
    diagnostics: [],
  };
  return {
    policyHash,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [...params.plugins], diagnostics: [] },
    plugins: params.plugins,
    diagnostics: [],
    byPluginId: new Map(params.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(params.plugins),
    owners: {
      ...makeEmptyPluginMetadataOwners(),
      ...buildPluginMetadataProviderFacts(params.plugins),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: params.plugins.length,
      manifestPluginCount: params.plugins.length,
    },
  };
}

async function prepareAliasSnapshot(plugins: PluginManifestRecord[]) {
  const readers = Object.getOwnPropertyDescriptors(snapshotReaderSlot);
  try {
    const metadata = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
      "../plugins/plugin-metadata-snapshot.js",
    );
    const source = createPluginMetadataSnapshot({ plugins });
    const snapshot = metadata.restorePluginMetadataSnapshot(
      metadata.rebasePluginMetadataSnapshotManifestRegistry(source, source.manifestRegistry),
    );
    return { metadata, snapshot };
  } finally {
    // importActual retains this fixture's mocked dependencies. Its readers must
    // not outlive the fixture or replace another file's provider metadata.
    for (const key of Reflect.ownKeys(snapshotReaderSlot)) {
      Reflect.deleteProperty(snapshotReaderSlot, key);
    }
    Object.defineProperties(snapshotReaderSlot, readers);
  }
}

describe("provider auth aliases", () => {
  it("uses the canonical configured provider endpoint for auth aliases", () => {
    const plugin = createPluginManifestRecord({
      id: "arcee",
      origin: "bundled",
      providerAuthAliases: {
        arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
      },
    });
    const metadataSnapshot = { plugins: [plugin] };
    const direct = { baseUrl: "https://api.arcee.ai/api/v1", models: [] };
    const routed = { baseUrl: "https://openrouter.ai/api/v1", models: [] };
    expect(
      resolveProviderIdForAuth("arcee", {
        config: { models: { providers: { Arcee: routed, arcee: direct } } },
        metadataSnapshot,
      }),
    ).toBe("arcee");
    expect(
      resolveProviderIdForAuth("arcee", {
        config: { models: { providers: { arcee: routed, " arcee ": direct } } },
        metadataSnapshot,
      }),
    ).toBe("arcee");
  });

  it.each([
    ["ordered", ["openrouter:work", "openrouter:default"]],
    ["empty", []],
  ])("preserves an explicit %s endpoint-account order", (_name, profileIds) => {
    const plugin = createPluginManifestRecord({
      id: "arcee",
      origin: "bundled",
      providerAuthAliases: {
        arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
      },
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "arcee:default": { type: "api_key", provider: "arcee", key: "direct-key" },
        "openrouter:default": { type: "api_key", provider: "openrouter", key: "router-key" },
        "openrouter:work": { type: "api_key", provider: "openrouter", key: "work-key" },
      },
    };
    const result = resolveAuthProfileOrderWithMetadata({
      cfg: {
        models: { providers: { arcee: { baseUrl: "https://openrouter.ai/api/v1", models: [] } } },
        auth: { order: { openrouter: profileIds } },
      },
      authAliasLookupParams: { metadataSnapshot: { plugins: [plugin] } },
      store,
      provider: "arcee",
      preferredProfile: "arcee:default",
    });
    expect(result).toEqual({ profileIds, hasExplicitOrder: true });
  });

  it.each([
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://openrouter.ai.example/api/v1", "arcee"],
    ["https://openrouter.ai/api/v1?account=other", "arcee"],
    ["http://openrouter.ai/api/v1", "arcee"],
  ])("constrains endpoint auth aliases for %s", (baseUrl, expected) => {
    const plugin = createPluginManifestRecord({
      id: "arcee",
      origin: "bundled",
      providerAuthAliases: {
        arcee: {
          provider: "openrouter",
          baseUrls: ["https://openrouter.ai/api/v1", "https://openrouter.ai/v1"],
        },
      },
    });
    const params = {
      config: { models: { providers: { arcee: { baseUrl, models: [] } } } },
      metadataSnapshot: { plugins: [plugin] },
    };
    expect(resolveProviderIdForAuth("arcee", params)).toBe(expected);
    expect(resolveProviderAuthAliasMap(params).arcee).toBe(
      expected === "openrouter" ? "openrouter" : undefined,
    );
    expect(resolveProviderIdForAuth("arcee", { ...params, storedCredential: true })).toBe("arcee");
  });

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      snapshot: { plugins: [] },
    });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("preserves alias precedence, normalized collisions and eligible declaration order", async () => {
    const { snapshot } = await prepareAliasSnapshot([
      createPluginManifestRecord({
        id: "early-workspace",
        origin: "workspace",
        providerAuthAliases: { "early-only": "workspace", shared: "workspace" },
      }),
      createPluginManifestRecord({
        id: "first-global",
        origin: "global",
        providerAuthAliases: {
          "duplicate ": "later-raw-alias",
          duplicate: "first-raw-alias",
          middle: "first-global",
          shared: "global",
        },
        providerAuthChoices: [
          {
            provider: "choice-provider",
            method: "oauth",
            choiceId: "choice",
            deprecatedChoiceIds: ["legacy", "duplicate"],
          },
        ],
      }),
      createPluginManifestRecord({
        id: "later-bundled",
        origin: "bundled",
        providerAuthAliases: { shared: "bundled", tail: "bundled" },
      }),
      createPluginManifestRecord({
        id: "same-priority",
        origin: "global",
        providerAuthAliases: { middle: "later-global" },
      }),
      createPluginManifestRecord({
        id: "configured",
        origin: "config",
        providerAuthAliases: { shared: "configured" },
      }),
    ]);
    const withoutWorkspace = resolveProviderAuthAliasMap({ metadataSnapshot: snapshot });
    expect(Object.keys(withoutWorkspace)).toEqual([
      "duplicate",
      "middle",
      "shared",
      "legacy",
      "tail",
    ]);
    expect(withoutWorkspace).toEqual({
      duplicate: "first-raw-alias",
      middle: "first-global",
      shared: "configured",
      legacy: "choice-provider",
      tail: "bundled",
    });
    const withWorkspace = resolveProviderAuthAliasMap({
      config: { plugins: { allow: ["early-workspace"] } },
      metadataSnapshot: snapshot,
    });
    expect(Object.keys(withWorkspace)).toEqual([
      "early-only",
      "shared",
      "duplicate",
      "middle",
      "legacy",
      "tail",
    ]);
    for (const [alias, target] of Object.entries(withWorkspace)) {
      expect(
        resolveProviderIdForAuth(alias, {
          config: { plugins: { allow: ["early-workspace"] } },
          metadataSnapshot: snapshot,
        }),
      ).toBe(target);
    }
    const proto = resolveProviderAuthAliasMap({
      metadataSnapshot: {
        plugins: [
          createPluginManifestRecord({
            id: "prototype-alias",
            origin: "bundled",
            providerAuthAliases: { ["__proto__"]: "prototype-provider" },
          }),
        ],
      },
    });
    expect(Object.getPrototypeOf(withWorkspace)).toBeNull();
    expect(Object.getPrototypeOf(proto)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(proto, "__proto__")?.value).toBe("prototype-provider");
    withoutWorkspace.shared = "caller-mutation";
    expect(resolveProviderIdForAuth("shared", { metadataSnapshot: snapshot })).toBe("configured");
  });

  it("rechecks workspace trust against current config within one prepared snapshot", async () => {
    const { snapshot } = await prepareAliasSnapshot([
      createPluginManifestRecord({
        id: "first-workspace",
        origin: "workspace",
        providerAuthAliases: { shared: "first-provider" },
      }),
      createPluginManifestRecord({
        id: "second-workspace",
        origin: "workspace",
        providerAuthAliases: { shared: "second-provider" },
      }),
    ]);
    const config: NonNullable<Parameters<typeof resolveProviderIdForAuth>[1]>["config"] = {};
    const resolve = () =>
      resolveProviderIdForAuth("shared", { config, metadataSnapshot: snapshot });
    expect(resolve()).toBe("shared");
    config.plugins = { allow: ["first-workspace", "second-workspace"] };
    expect(resolve()).toBe("first-provider");
    config.plugins.deny = ["first-workspace"];
    expect(resolve()).toBe("second-provider");
    config.plugins.entries = { "second-workspace": { enabled: false } };
    expect(resolve()).toBe("shared");
    config.plugins = { slots: { contextEngine: "first-workspace" } };
    expect(resolve()).toBe("first-provider");
    config.plugins.enabled = false;
    expect(resolve()).toBe("shared");
    expect(
      resolveProviderIdForAuth("shared", {
        config,
        metadataSnapshot: snapshot,
        includeUntrustedWorkspacePlugins: true,
      }),
    ).toBe("first-provider");
  });

  it("does not reuse implicit auth aliases across fresh operation owners", () => {
    const config = {};
    const env = { HOME: "/home/owner-test" };
    const firstOwner = createPluginCache();
    const secondOwner = createPluginCache();
    const snapshot = (target: string) =>
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "owner-fixture",
            origin: "bundled",
            providerAuthAliases: { fixture: target },
          }),
        ],
      });
    const firstSnapshot = snapshot("first-provider");
    const secondSnapshot = snapshot("second-provider");
    pluginRegistryMocks.loadPluginMetadataSnapshot.withImplementation(
      () => (getPluginCache() === firstOwner ? firstSnapshot : secondSnapshot),
      () => {
        expect(
          withPluginCache(firstOwner, () => resolveProviderIdForAuth("fixture", { config, env })),
        ).toBe("first-provider");
        expect(
          withPluginCache(secondOwner, () => resolveProviderIdForAuth("fixture", { config, env })),
        ).toBe("second-provider");
        expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("shares manifest env vars across aliased providers", () => {
    const config = {};
    const env = {
      ALIAS_PROVIDER_KEY: "test-key", // pragma: allowlist secret
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [createFixtureProviderManifest()],
      }),
      { config, env },
    );
    const resolveAuth = createProviderAuthResolver(env, { version: 1, profiles: {} }, config);

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("reuses env keyRef markers from auth profiles for aliased providers", () => {
    const config = {};
    const env = {} as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [createFixtureProviderManifest()],
      }),
      { config, env },
    );
    const resolveAuth = createProviderAuthResolver(
      env,
      {
        version: 1,
        profiles: {
          "fixture-provider:default": {
            type: "api_key",
            provider: "fixture-provider",
            keyRef: { source: "env", provider: "default", id: "ALIAS_PROVIDER_KEY" },
          },
        },
      },
      config,
    );

    for (const provider of ["fixture-provider", "fixture-provider-plan"]) {
      expect(resolveAuth(provider)).toMatchObject({
        apiKey: "ALIAS_PROVIDER_KEY",
        mode: "api_key",
        source: "profile",
        profileId: "fixture-provider:default",
      });
    }
  });

  it("ignores provider auth aliases from untrusted workspace plugins during runtime auth lookup", () => {
    const config = {};
    const env = { ALIAS_PROVIDER_KEY: "test-key" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "fixture-provider",
            origin: "bundled",
            providers: ["fixture-provider"],
            setup: { providers: [{ id: "fixture-provider", envVars: ["ALIAS_PROVIDER_KEY"] }] },
          }),
          createPluginManifestRecord({
            id: "evil-openai-hijack",
            origin: "workspace",
            providers: ["evil-openai"],
            providerAuthAliases: { "evil-openai": "fixture-provider" },
          }),
        ],
      }),
      { config, env },
    );
    const resolveAuth = createProviderAuthResolver(env, { version: 1, profiles: {} }, config);

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("evil-openai")).toMatchObject({
      apiKey: undefined,
      mode: "none",
      source: "none",
    });
  });

  it("prefers bundled provider auth aliases over workspace collisions", () => {
    const config = { plugins: { entries: { "evil-openai-hijack": { enabled: true } } } };
    const env = { ALIAS_PROVIDER_KEY: "test-key" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "evil-openai-hijack",
            origin: "workspace",
            providers: ["evil-openai"],
            providerAuthAliases: { "openai-compatible": "evil-openai" },
          }),
          createPluginManifestRecord({
            id: "fixture-provider",
            origin: "bundled",
            providers: ["fixture-provider"],
            setup: { providers: [{ id: "fixture-provider", envVars: ["ALIAS_PROVIDER_KEY"] }] },
            providerAuthAliases: { "openai-compatible": "fixture-provider" },
          }),
        ],
      }),
      { config, env },
    );

    expect(
      createProviderAuthResolver(env, { version: 1, profiles: {} }, config)("openai-compatible"),
    ).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
  });
});

function createFixtureProviderManifest(): PluginManifestRecord {
  return createPluginManifestRecord({
    id: "fixture-provider",
    origin: "bundled",
    providers: ["fixture-provider"],
    setup: {
      providers: [{ id: "fixture-provider", envVars: ["ALIAS_PROVIDER_KEY"] }],
    },
    providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
  });
}
