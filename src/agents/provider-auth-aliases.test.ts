import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot as createBaseSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  emptyRegistry: () => ({ plugins: [], diagnostics: [] }),
  loadPluginMetadataSnapshot: vi.fn(() => createPluginMetadataSnapshot({ plugins: [] })),
}));

// mock-isolation: Alias fixtures supply their manifest inventory without reading installed plugins.
vi.mock("../plugins/manifest-registry-installed.js", async (importOriginal) => {
  const { selectInstalledPluginManifestRecords } =
    await importOriginal<typeof import("../plugins/manifest-registry-installed.js")>();
  return {
    selectInstalledPluginManifestRecords,
    loadPluginManifestRegistryForInstalledIndex: pluginRegistryMocks.emptyRegistry,
    resolveInstalledManifestRegistryIndexFingerprint: () => "test-index",
  };
});

// mock-isolation: Alias resolution must not activate the process plugin registry.
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: pluginRegistryMocks.emptyRegistry,
  loadPluginRegistrySnapshotWithMetadata: () => ({ snapshot: { plugins: [] } }),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
}));

import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
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

function createPluginMetadataSnapshot(params: {
  config?: Parameters<typeof createBaseSnapshot>[0]["config"];
  plugins: readonly PluginManifestRecord[];
}): PluginMetadataSnapshot {
  const snapshot = createBaseSnapshot({
    config: params.config,
    manifestRegistry: { plugins: [...params.plugins], diagnostics: [] },
  });
  snapshot.index.plugins = params.plugins.map((plugin) => ({
    pluginId: plugin.id,
    manifestPath: plugin.manifestPath,
    manifestHash: plugin.id + ":manifest",
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    enabled: true,
    enabledByDefault: true,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
  }));
  Object.assign(snapshot.owners, buildPluginMetadataProviderFacts(params.plugins));
  snapshot.metrics.indexPluginCount = params.plugins.length;
  return snapshot;
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

const expectedEnvAuth = { apiKey: "ALIAS_PROVIDER_KEY", mode: "api_key", source: "env" };
const endpoint = (baseUrl: string) => ({ baseUrl, models: [] });
function resolveEndpoint(providers: Record<string, ReturnType<typeof endpoint>>) {
  return resolveProviderIdForAuth("arcee", {
    config: { models: { providers } },
    metadataSnapshot: { plugins: [endpointAlias()] },
  });
}

describe("provider auth aliases", () => {
  it.each(["Arcee", " arcee "])("uses canonical endpoint precedence over %j", (alias) => {
    const direct = endpoint("https://api.arcee.ai/api/v1");
    const routed = endpoint("https://openrouter.ai/api/v1");
    const providers =
      alias === "Arcee" ? { [alias]: routed, arcee: direct } : { arcee: routed, [alias]: direct };
    expect(resolveEndpoint(providers)).toBe("arcee");
  });

  it.each([
    ["ordered", ["openrouter:work", "openrouter:default"]],
    ["empty", []],
  ])("preserves an explicit %s endpoint-account order", (_name, profileIds) => {
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
        models: { providers: { arcee: endpoint("https://openrouter.ai/api/v1") } },
        auth: { order: { openrouter: profileIds } },
      },
      authAliasLookupParams: { metadataSnapshot: { plugins: [endpointAlias()] } },
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
    const plugin = endpointAlias(["https://openrouter.ai/api/v1", "https://openrouter.ai/v1"]);
    const params = {
      config: { models: { providers: { arcee: endpoint(baseUrl) } } },
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
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("preserves alias precedence, normalized collisions and eligible declaration order", async () => {
    const { snapshot } = await prepareAliasSnapshot([
      aliasPlugin("early-workspace", "workspace", {
        "early-only": "workspace",
        shared: "workspace",
        tail: "workspace",
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
      aliasPlugin("later-bundled", "bundled", { shared: "bundled", tail: "bundled" }),
      aliasPlugin("same-priority", "global", { middle: "later-global" }),
      aliasPlugin("configured", "config", { shared: "configured" }),
    ]);
    const withoutWorkspace = resolveProviderAuthAliasMap({ metadataSnapshot: snapshot });
    expect(Object.entries(withoutWorkspace)).toEqual([
      ["duplicate", "first-raw-alias"],
      ["middle", "first-global"],
      ["shared", "configured"],
      ["legacy", "choice-provider"],
      ["tail", "bundled"],
    ]);
    const trusted = {
      config: { plugins: { allow: ["early-workspace"] } },
      metadataSnapshot: snapshot,
    };
    const withWorkspace = resolveProviderAuthAliasMap(trusted);
    expect(Object.entries(withWorkspace)).toEqual([
      ["early-only", "workspace"],
      ["shared", "configured"],
      ["tail", "bundled"],
      ["duplicate", "first-raw-alias"],
      ["middle", "first-global"],
      ["legacy", "choice-provider"],
    ]);
    expect(resolveProviderIdForAuth("tail", trusted)).toBe("bundled");
    const proto = resolveProviderAuthAliasMap({
      metadataSnapshot: {
        plugins: [
          aliasPlugin("prototype-alias", "bundled", { ["__proto__"]: "prototype-provider" }),
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
      aliasPlugin("first-workspace", "workspace", { shared: "first-provider" }),
      aliasPlugin("second-workspace", "workspace", { shared: "second-provider" }),
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
        plugins: [aliasPlugin("owner-fixture", "bundled", { fixture: target })],
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
      },
    );
  });

  it.each(["env", "profile"] as const)(
    "resolves %s credentials for canonical and aliased providers",
    (source) => {
      const profiles: AuthProfileStore["profiles"] =
        source === "profile"
          ? {
              "fixture-provider:default": {
                type: "api_key",
                provider: "fixture-provider",
                keyRef: { source: "env", provider: "default", id: "ALIAS_PROVIDER_KEY" },
              },
            }
          : {};
      const resolveAuth = installAuthFixture(
        {},
        source === "env" ? { ALIAS_PROVIDER_KEY: "test-key" } : {},
        profiles,
      );
      for (const provider of ["fixture-provider", "fixture-provider-plan"]) {
        expect(resolveAuth(provider)).toMatchObject({
          ...expectedEnvAuth,
          source,
          ...(source === "profile" ? { profileId: "fixture-provider:default" } : {}),
        });
      }
    },
  );

  it("ignores provider auth aliases from untrusted workspace plugins during runtime auth lookup", () => {
    const config = {};
    const env = { ALIAS_PROVIDER_KEY: "test-key" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    const resolveAuth = installAuthFixture(config, env, {}, [
      { ...createFixtureProviderManifest(), providerAuthAliases: undefined },
      createPluginManifestRecord({
        id: "evil-openai-hijack",
        origin: "workspace",
        providers: ["evil-openai"],
        providerAuthAliases: { "evil-openai": "fixture-provider" },
      }),
    ]);

    expect(resolveAuth("fixture-provider")).toMatchObject(expectedEnvAuth);
    expect(resolveAuth("evil-openai")).toMatchObject({
      apiKey: undefined,
      mode: "none",
      source: "none",
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

function endpointAlias(baseUrls = ["https://openrouter.ai/api/v1"]) {
  return aliasPlugin("arcee", "bundled", { arcee: { provider: "openrouter", baseUrls } });
}

function installAuthFixture(
  config: Parameters<typeof createProviderAuthResolver>[2] = {},
  env: NodeJS.ProcessEnv = {},
  profiles: AuthProfileStore["profiles"] = {},
  plugins = [createFixtureProviderManifest()],
) {
  setCurrentPluginMetadataSnapshot(createPluginMetadataSnapshot({ config, plugins }), {
    config,
    env,
  });
  return createProviderAuthResolver(env, { version: 1, profiles }, config);
}

function aliasPlugin(
  id: string,
  origin: PluginManifestRecord["origin"],
  providerAuthAliases: PluginManifestRecord["providerAuthAliases"],
) {
  return createPluginManifestRecord({ id, origin, providerAuthAliases });
}
