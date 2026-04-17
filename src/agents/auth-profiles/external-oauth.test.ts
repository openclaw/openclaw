import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import {
  __testing,
  overlayExternalOAuthProfiles,
  shouldPersistExternalOAuthProfile,
} from "./external-auth.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<
  (params: unknown) => ProviderExternalAuthProfile[]
>(() => []);
const { readCodexCliCredentialsCachedMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<() => OAuthCredential | null>(() => null),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

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

describe("auth external oauth helpers", () => {
  beforeEach(() => {
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
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

  it("overlays external CLI OAuth only when the stored credential is no longer usable", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({
        access: "fresh-cli-access-token",
        refresh: "fresh-cli-refresh-token",
        expires: Date.now() + 60_000,
      }),
    );

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": createCredential({
          access: "stale-store-access-token",
          refresh: "stale-store-refresh-token",
          expires: Date.now() - 60_000,
        }),
      }),
    );

    expect(overlaid.profiles["openai-codex:default"]).toMatchObject({
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: expect.any(Number),
    });
  });

  it("keeps healthy local oauth even when external cli has a fresher token", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({
        access: "fresh-cli-access-token",
        refresh: "fresh-cli-refresh-token",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": createCredential({
          access: "healthy-local-access-token",
          refresh: "healthy-local-refresh-token",
          expires: Date.now() + 60_000,
        }),
      }),
    );

    expect(overlaid.profiles["openai-codex:default"]).toMatchObject({
      access: "healthy-local-access-token",
      refresh: "healthy-local-refresh-token",
    });
  });
});
