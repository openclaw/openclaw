import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import {
  __testing,
  listRuntimeOnlyExternalAuthProfileIds,
  listRuntimeOnlyExternalAuthProfiles,
  overlayExternalAuthProfiles,
  overlayExternalOAuthProfiles,
  shouldPersistExternalAuthProfile,
  shouldPersistExternalOAuthProfile,
} from "./external-auth.js";
import type { ApiKeyCredential, AuthProfileStore, OAuthCredential } from "./types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<
  (params: unknown) => ProviderExternalAuthProfile[]
>(() => []);

function createStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return { version: 1, profiles };
}

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "access-token",
    refresh: "refresh-token",
    expires: 123,
    ...overrides,
  };
}

function createApiKeyCredential(overrides: Partial<ApiKeyCredential> = {}): ApiKeyCredential {
  return {
    type: "api_key",
    provider: "zai",
    key: "sk-zai-1",
    ...overrides,
  };
}

describe("auth external oauth helpers", () => {
  beforeEach(() => {
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    __testing.setResolveExternalAuthProfilesForTest(resolveExternalAuthProfilesWithPluginsMock);
  });

  afterEach(() => {
    __testing.resetResolveExternalAuthProfilesForTest();
  });

  it("overlays provider-managed runtime oauth profiles onto the store", () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential: createCredential(),
      },
    ]);

    const store = overlayExternalOAuthProfiles(createStore());

    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
    });
  });

  it("overlays runtime-only api-key profiles onto the store", () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "zai:runtime-env-1",
        credential: createApiKeyCredential(),
      },
    ]);

    const store = overlayExternalAuthProfiles(createStore());

    expect(store.profiles["zai:runtime-env-1"]).toMatchObject({
      type: "api_key",
      provider: "zai",
      key: "sk-zai-1",
    });
  });

  it("omits exact runtime-only overlays from persisted store writes", () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential,
      },
    ]);

    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(false);
  });

  it("keeps persisted copies when the external overlay is marked persisted", () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential,
        persistence: "persisted",
      },
    ]);

    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(true);
  });

  it("keeps stale local copies when runtime overlay no longer matches", () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential: createCredential({ access: "fresh-access-token" }),
      },
    ]);

    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(true);
  });

  it("omits exact runtime-only api-key overlays from persisted store writes", () => {
    const credential = createApiKeyCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "zai:runtime-env-1",
        credential,
      },
    ]);

    const shouldPersist = shouldPersistExternalAuthProfile({
      store: createStore({ "zai:runtime-env-1": credential }),
      profileId: "zai:runtime-env-1",
      credential,
    });

    expect(shouldPersist).toBe(false);
  });

  it("lists runtime-only external auth profile ids", () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "zai:runtime-env-1",
        credential: createApiKeyCredential(),
      },
      {
        profileId: "zai:persisted",
        credential: createApiKeyCredential({ key: "sk-zai-persisted" }),
        persistence: "persisted",
      },
    ]);

    const profileIds = listRuntimeOnlyExternalAuthProfileIds({
      store: createStore({
        "zai:runtime-env-1": createApiKeyCredential(),
        "zai:persisted": createApiKeyCredential({ key: "sk-zai-persisted" }),
      }),
    });

    expect(profileIds).toEqual(["zai:runtime-env-1"]);
  });

  it("exposes runtime-only external auth profile priority metadata", () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "zai:runtime-live-override",
        credential: createApiKeyCredential({ key: "sk-zai-live" }),
        selectionPriority: "highest",
      },
    ]);

    const profiles = listRuntimeOnlyExternalAuthProfiles({
      store: createStore({
        "zai:runtime-live-override": createApiKeyCredential({ key: "sk-zai-live" }),
      }),
    });

    expect(profiles).toEqual([
      {
        profileId: "zai:runtime-live-override",
        selectionPriority: "highest",
      },
    ]);
  });

  it("keeps persisted profiles when a live override uses a separate runtime-only id", () => {
    const persistedCredential = createApiKeyCredential({ key: "sk-zai-default" });
    const runtimeCredential = createApiKeyCredential({ key: "sk-zai-live" });
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([
      {
        profileId: "zai:runtime-live-override",
        credential: runtimeCredential,
        selectionPriority: "highest",
      },
    ]);

    const shouldPersistPersisted = shouldPersistExternalAuthProfile({
      store: createStore({
        "zai:default": persistedCredential,
        "zai:runtime-live-override": runtimeCredential,
      }),
      profileId: "zai:default",
      credential: persistedCredential,
    });
    const shouldPersistRuntime = shouldPersistExternalAuthProfile({
      store: createStore({
        "zai:default": persistedCredential,
        "zai:runtime-live-override": runtimeCredential,
      }),
      profileId: "zai:runtime-live-override",
      credential: runtimeCredential,
    });
    expect(shouldPersistPersisted).toBe(true);
    expect(shouldPersistRuntime).toBe(false);
  });
});
