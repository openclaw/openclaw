import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as currentMetadata from "../../plugins/current-plugin-metadata-snapshot.js";
import * as metadata from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createProviderExternalAuthResolver } from "../../plugins/provider-external-auth-core.js";
import {
  createExternalAuthRuntime,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import { testing } from "./external-auth.test-support.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  registerRuntimeAuthProfileStoreMutationListener,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { ensureAuthProfileStore } from "./store-runtime.js";
import type { OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

const readMiniMax = vi.hoisted(() => vi.fn<() => OAuthCredential | null>(() => null));
vi.mock("../cli-credentials.js", () => ({ readMiniMaxCliCredentialsCached: readMiniMax }));
const credential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: "oauth",
  provider: "openai",
  access: "access",
  refresh: "refresh",
  expires: Date.now() + 1_800_000,
  ...overrides,
});

beforeEach(() => {
  prepareSharedAuthStoreOwnershipForNative();
  readMiniMax.mockReset().mockReturnValue(null);
  testing.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});
afterEach(() => {
  testing.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});

describe("external auth owner", () => {
  it.each(["expired", "matching-refresh", "matching-access"])(
    "preserves MiniMax provenance with %s credentials",
    (kind) => {
      const profileId = "minimax-portal:minimax-cli";
      const stored = credential({
        provider: "minimax-portal",
        expires: kind === "expired" ? 1 : Date.now() + 1_800_000,
        ...(kind === "matching-access" ? { authFlow: "device-code" } : {}),
      });
      const imported = credential({
        provider: "minimax-portal",
        access: kind === "matching-access" ? stored.access : "rotated-access",
        refresh: kind === "matching-refresh" ? stored.refresh : "rotated-refresh",
      });
      readMiniMax.mockReturnValue(imported);
      const store = { version: 1, profiles: { [profileId]: stored } };
      const synced = syncPersistedExternalCliAuthProfiles(store);
      const expected = kind === "expired" ? imported : stored;
      expect(synced.profiles[profileId]).toEqual({
        ...expected,
        ...(kind === "matching-access" ? {} : { authFlow: "external-cli" }),
      });
      const syncedCredential = synced.profiles[profileId];
      if (syncedCredential?.type !== "oauth") {
        throw new Error("Expected persisted OAuth credential");
      }
      expect(isPersistedExternalCliAuthProfile({ profileId, credential: syncedCredential })).toBe(
        kind !== "matching-access",
      );
      expect(
        isPersistedExternalCliAuthProfile({
          profileId,
          credential: { ...stored, authFlow: "device-code" },
        }),
      ).toBe(false);
      expect(
        isPersistedExternalCliAuthProfile({
          profileId: "openai:default",
          credential: credential({ authFlow: "external-cli" }),
        }),
      ).toBe(false);
      expect(readMiniMax).toHaveBeenCalledOnce();
      const overlaid = createExternalAuthRuntime(
        () => [],
        async () => () => [],
      ).overlayExternalAuthProfiles(store);
      expect(overlaid.profiles[profileId]).toEqual(synced.profiles[profileId]);
    },
  );

  it("keeps plugin ownership over retired CLI slots and forwards active config", () => {
    testing.resetResolveExternalAuthProfilesForTest();
    const config = {
      models: { providers: { openai: { auth: "oauth" as const, baseUrl: "", models: [] } } },
    };
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
    const pluginCredential = credential();
    const resolver = vi.fn(() => [{ profileId: "openai:default", credential: pluginCredential }]);
    const runtime = createExternalAuthRuntime(resolver, async () => resolver);
    const first = runtime.overlayExternalAuthProfiles(
      { version: 1, profiles: {} },
      { config, pluginMetadataSnapshot, externalCliProviderIds: ["openai"] },
    );
    const next = runtime.overlayExternalAuthProfiles(first, {
      config,
      pluginMetadataSnapshot,
      externalCliProviderIds: ["openai"],
    });
    expect(next.profiles["openai:default"]).toEqual(pluginCredential);
    expect(next.runtimeExternalProfileIds).toEqual(["openai:default"]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenLastCalledWith(
      expect.objectContaining({ config, context: expect.objectContaining({ config }) }),
    );
  });

  it("prepares cold external hooks and applies auth pins with the captured metadata", async () => {
    testing.resetResolveExternalAuthProfilesForTest();
    vi.spyOn(currentMetadata, "getCurrentPluginMetadataSnapshot").mockReturnValue(undefined);
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "alias-owner",
          providers: ["alias"],
          contracts: { externalAuthProviders: ["alias"] },
          providerAuthAliases: { alias: "canonical" },
        },
      ],
    });
    const prepareMetadata = vi
      .spyOn(metadata, "resolvePluginMetadataSnapshotAsync")
      .mockResolvedValue(pluginMetadataSnapshot);
    const syncHooks = vi.fn(() => {
      throw new Error("synchronous hook discovery");
    });
    const asyncHooks = vi.fn(async () => [
      {
        id: "alias",
        label: "Alias",
        auth: [],
        resolveExternalAuthProfiles: () => [
          {
            profileId: "alias:external",
            credential: credential({ provider: "alias" }),
          },
        ],
      },
    ]);
    const resolver = createProviderExternalAuthResolver({
      resolveProviderPluginsForHooks: syncHooks,
      resolveProviderPluginsForHooksAsync: asyncHooks,
    });
    const runtime = createExternalAuthRuntime(
      resolver.resolveExternalAuthProfilesWithPlugins,
      resolver.prepareExternalAuthProfilesWithPlugins,
    );
    const config = {
      models: { providers: { canonical: { auth: "api-key" as const, baseUrl: "", models: [] } } },
    };
    const result = await runtime.overlayExternalAuthProfilesAsync(
      { version: 1, profiles: {} },
      { config, env: {}, externalCliProviderIds: [] },
    );
    expect(result.profiles).toEqual({});
    expect(prepareMetadata).toHaveBeenCalledWith({ config, env: {} });
    expect(asyncHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginMetadataSnapshot,
        onlyPluginIds: ["alias-owner"],
      }),
    );
    expect(syncHooks).not.toHaveBeenCalled();
  });

  it("prepares hook ownership once and reads the current store at each write", async () => {
    testing.resetResolveExternalAuthProfilesForTest();
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "external-owner", contracts: { externalAuthProviders: ["custom"] } }],
    });
    const hook = vi.fn((context: { store: RuntimeAuthProfileStore }) => [
      {
        profileId: "custom:external",
        credential: credential({
          provider: "custom",
          access: Object.keys(context.store.profiles).join(","),
        }),
      },
    ]);
    const asyncHooks = vi.fn(async () => [
      { id: "custom", label: "Custom", auth: [], resolveExternalAuthProfiles: hook },
    ]);
    const resolver = createProviderExternalAuthResolver({
      resolveProviderPluginsForHooks: () => {
        throw new Error("synchronous discovery");
      },
      resolveProviderPluginsForHooksAsync: asyncHooks,
    });
    const runtime = createExternalAuthRuntime(
      resolver.resolveExternalAuthProfilesWithPlugins,
      resolver.prepareExternalAuthProfilesWithPlugins,
    );
    const list = await runtime.prepareRuntimeExternalAuthProfiles({
      pluginMetadataSnapshot,
      externalCliProviderIds: [],
    });
    expect(hook).not.toHaveBeenCalled();
    const store: RuntimeAuthProfileStore = { version: 1, profiles: {} };
    expect(list({ store })[0]?.credential.access).toBe("");
    store.profiles.written = credential();
    expect(list({ store })[0]?.credential.access).toBe("written");
    expect(asyncHooks).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains external account health during a scoped=%s refresh", (scoped) => {
    const agentDir = "/tmp/openclaw-external-owner-health";
    const profileId = "openai:external";
    const external = credential();
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: { [profileId]: external },
      order: { openai: [profileId] },
      lastGood: { openai: profileId },
      usageStats: { [profileId]: { lastUsed: 17, cooldownUntil: 123_456 } },
      runtimeExternalProfileIds: [profileId],
    };
    testing.setResolveExternalAuthProfilesForTest(() => [{ profileId, credential: external }]);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    const loaded = ensureAuthProfileStore(agentDir, {
      ...(scoped ? { externalCliProviderIds: ["openai"] } : {}),
      allowKeychainPrompt: false,
      readOnly: true,
      syncExternalCli: false,
    });
    // Scoped lookups publish retained health; ordinary lookups return it to the caller.
    const retained = scoped ? getRuntimeAuthProfileStoreSnapshotCore(agentDir) : loaded;
    expect(retained).toMatchObject({
      profiles: store.profiles,
      order: store.order,
      lastGood: store.lastGood,
      usageStats: store.usageStats,
    });
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.usageStats).toEqual(store.usageStats);
  });

  it.each([undefined, "resolved-key"])(
    "keeps prepared API-key refs during ordinary scoped reads (%s)",
    (key) => {
      const agentDir = "/tmp/openclaw-external-owner-prepared";
      const profileId = key ? "openai:configured" : "openai:default";
      const store: RuntimeAuthProfileStore = {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openai",
            key,
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
      const listener = vi.fn();
      const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
      try {
        const loaded = ensureAuthProfileStore(agentDir, {
          externalCliProviderIds: ["openai"],
          allowKeychainPrompt: false,
          readOnly: true,
          syncExternalCli: false,
        });
        expect(loaded.profiles).toEqual(store.profiles);
        expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles).toEqual(store.profiles);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    },
  );
});
