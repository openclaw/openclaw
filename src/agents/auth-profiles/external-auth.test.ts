import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExternalAuthRuntime,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import { testing } from "./external-auth.test-support.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { getRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
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
  readMiniMax.mockReset().mockReturnValue(null);
  testing.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});
afterEach(() => {
  testing.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
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
      const overlaid = createExternalAuthRuntime(() => []).overlayExternalAuthProfiles(store);
      expect(overlaid.profiles[profileId]).toEqual(synced.profiles[profileId]);
      expect(getRuntimeExternalCliProfileIds(overlaid)).toEqual([]);
    },
  );

  it("keeps plugin ownership over retired CLI slots and forwards active config", () => {
    testing.resetResolveExternalAuthProfilesForTest();
    const config = {
      models: { providers: { openai: { auth: "oauth" as const, baseUrl: "", models: [] } } },
    };
    const pluginCredential = credential();
    const resolver = vi.fn(() => [{ profileId: "openai:default", credential: pluginCredential }]);
    const runtime = createExternalAuthRuntime(resolver);
    const first = runtime.overlayExternalAuthProfiles(
      { version: 1, profiles: {} },
      { config, externalCliProviderIds: ["openai"] },
    );
    const next = runtime.overlayExternalAuthProfiles(first, {
      config,
      externalCliProviderIds: ["openai"],
    });
    expect(next.profiles["openai:default"]).toEqual(pluginCredential);
    expect(next.runtimeExternalProfileIds).toEqual(["openai:default"]);
    expect(getRuntimeExternalCliProfileIds(next)).toEqual([]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenLastCalledWith(
      expect.objectContaining({ config, context: expect.objectContaining({ config }) }),
    );
  });

  it("releases only the requested retired CLI overlay", () => {
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": credential(),
        "claude-cli:default": credential({ provider: "claude-cli" }),
      },
      runtimeExternalProfileIds: ["openai:default", "claude-cli:default"],
      runtimeExternalCliProfileIds: ["openai:default", "claude-cli:default"],
    };
    const next = createExternalAuthRuntime(() => []).overlayExternalAuthProfiles(store, {
      externalCliProfileIds: ["openai:default"],
    });
    expect(next.profiles["openai:default"]).toBeUndefined();
    expect(next.profiles["claude-cli:default"]).toEqual(store.profiles["claude-cli:default"]);
    expect(getRuntimeExternalCliProfileIds(next)).toEqual(["claude-cli:default"]);
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
