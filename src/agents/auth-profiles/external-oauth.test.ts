import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<
  (params: unknown) => ProviderExternalAuthProfile[]
>(() => []);

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: (params: unknown) =>
    resolveExternalAuthProfilesWithPluginsMock(params),
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
  });

  it("overlays provider-managed runtime oauth profiles onto the store", async () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential: createCredential(),
      },
    ]);

    const { overlayExternalOAuthProfiles } = await import("./external-auth.js");
    const store = overlayExternalOAuthProfiles(createStore());

    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
    });
  });

  it("omits exact runtime-only overlays from persisted store writes", async () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential,
      },
    ]);

    const { shouldPersistExternalOAuthProfile } = await import("./external-auth.js");
    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(false);
  });

  it("keeps persisted copies when the external overlay is marked persisted", async () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential,
        persistence: "persisted",
      },
    ]);

    const { shouldPersistExternalOAuthProfile } = await import("./external-auth.js");
    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(true);
  });

  it("keeps stale local copies when runtime overlay no longer matches", async () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential: createCredential({ access: "fresh-access-token" }),
      },
    ]);

    const { shouldPersistExternalOAuthProfile } = await import("./external-auth.js");
    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(true);
  });
});
