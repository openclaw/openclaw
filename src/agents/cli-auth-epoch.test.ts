import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resetCliAuthEpochTestDeps,
  resolveCliAuthEpoch,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.js";

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
  });

  function expectCliAuthEpoch(
    epoch: Awaited<ReturnType<typeof resolveCliAuthEpoch>>,
    label = "auth epoch",
  ): asserts epoch is string {
    expect(epoch, label).toEqual(expect.stringMatching(/\S/));
  }

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await expect(resolveCliAuthEpoch({ provider: "claude-cli" })).resolves.toBeUndefined();
    await expect(
      resolveCliAuthEpoch({
        provider: "google-gemini-cli",
        authProfileId: "google:work",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps identity-less claude cli oauth epochs stable across token changes", async () => {
    let access = "access-a";
    let refresh = "refresh-a";
    let expires = 1;
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access,
        refresh,
        expires,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    access = "access-b";
    refresh = "refresh-b";
    expires = 2;
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
  });

  it("changes claude cli token epochs when the static token changes", async () => {
    let token = "token-a";
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "token",
        provider: "anthropic",
        token,
        expires: 1,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    token = "token-b";
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("keeps gemini cli oauth epochs stable through token rotation and flips on account change", async () => {
    let access = "gemini-access-a";
    let refresh = "gemini-refresh-a";
    let expires = 1;
    let accountId: string | undefined = "google-account-1";
    let email: string | undefined = "user-a@example.com";
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => ({
        type: "oauth",
        provider: "google-gemini-cli",
        access,
        refresh,
        expires,
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });
    access = "gemini-access-b";
    refresh = "gemini-refresh-b";
    expires = 2;
    const second = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(first);
    // Access and refresh rotation must not shift the epoch while the lifted
    // Google-account identity is stable.
    expect(second).toBe(first);

    email = "user-b@example.com";
    const third = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(third);
    expect(third).not.toBe(second);

    accountId = "google-account-2";
    const fourth = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(fourth);
    expect(fourth).not.toBe(third);
  });

  it("falls back to the identity-less oauth epoch when gemini id_token is absent", async () => {
    let refresh = "gemini-refresh-a";
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => ({
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh,
        expires: 1,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });
    refresh = "gemini-refresh-b";
    const second = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(first);
    // Without lifted identity, the epoch is a provider-keyed constant that
    // survives token rotation — same fallback as the Claude CLI OAuth branch.
    expect(second).toBe(first);
  });

  it("keeps oauth auth-profile epochs stable across token refreshes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh-a",
          expires: 1,
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh-b",
          expires: 2,
          email: "user@example.com",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
  });

  it("keeps oauth auth-profile epochs stable across profile id aliases for the same account", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh-a",
          expires: 1,
          email: "user@example.com",
        },
        "anthropic:work-alias": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh-b",
          expires: 2,
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work-alias",
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
  });

  it("keeps identity-less oauth auth-profile epochs scoped to the profile id", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh-a",
          expires: 1,
        },
        "anthropic:personal": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh-b",
          expires: 2,
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:personal",
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("changes oauth auth-profile epochs when the account identity changes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: 1,
          email: "user-a@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: 1,
          email: "user-b@example.com",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("profile credential is canonical when present — local codex state does not affect epoch", async () => {
    // When authProfileId resolves to a profile credential, the local CLI credential
    // is excluded from the epoch entirely. Only profile identity fields (email,
    // accountId) shift the epoch; local token rotation and local identity changes
    // are irrelevant once the profile is the canonical source.
    let localAccess = "local-access-a";
    let localRefresh = "local-refresh-a";
    let localAccountId = "acct-local-1";
    let profileRefresh = "profile-refresh-a";
    let email = "user-a@example.com";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai-codex",
        access: localAccess,
        refresh: localRefresh,
        expires: 1,
        accountId: localAccountId,
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "profile-access",
            refresh: profileRefresh,
            expires: 1,
            email,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    // Local token rotation — must not affect epoch
    localAccess = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    localRefresh = "local-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    // Local accountId change — must not affect epoch (local is excluded)
    localAccountId = "acct-local-2";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    // Profile refresh rotation — must not affect epoch (non-identity field)
    profileRefresh = "profile-refresh-b";
    const fifth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    // Profile email change — MUST shift epoch
    email = "user-b@example.com";
    const sixth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(fourth).toBe(third);
    expect(fifth).toBe(fourth);
    expectCliAuthEpoch(sixth);
    expect(sixth).not.toBe(fifth);
  });

  it("can ignore local codex state when the backend is profile-owned", async () => {
    let localAccess = "local-access-a";
    let profileRefresh = "profile-refresh-a";
    let profileAccountId = "acct-1";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai-codex",
        access: localAccess,
        refresh: "local-refresh",
        expires: 1,
        accountId: "acct-1",
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "profile-access",
            refresh: profileRefresh,
            expires: 1,
            accountId: profileAccountId,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });
    localAccess = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });
    profileRefresh = "profile-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });
    profileAccountId = "acct-2";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expectCliAuthEpoch(fourth);
    expect(fourth).not.toBe(third);
  });

  it("keeps epoch stable when local credential file flips while auth-profile credential is present", async () => {
    // Regression for #80178: when claude writes ~/.claude/.credentials.json during
    // a background refresh, the local file presence flipped, causing a spurious epoch
    // change that invalidated every live CLI session. The profile credential is the
    // canonical identity; local file is only used in the bootstrap (no-profile) case.
    let localCredential: {
      type: "oauth";
      provider: "anthropic";
      access: string;
      refresh: string;
      expires: number;
    } | null = {
      type: "oauth",
      provider: "anthropic",
      access: "local-access",
      refresh: "local-refresh",
      expires: 1,
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "profile-access",
          refresh: "profile-refresh",
          expires: 1,
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => localCredential,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const withLocal = await resolveCliAuthEpoch({
      provider: "claude-cli",
      authProfileId: "anthropic:work",
    });
    // Simulate local file disappearing (e.g. credential rotation in progress)
    localCredential = null;
    const withoutLocal = await resolveCliAuthEpoch({
      provider: "claude-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(withLocal);
    // Local file presence must not affect epoch when profile credential is present
    expect(withoutLocal).toBe(withLocal);
  });

  it("falls back to local credential fingerprint when no auth-profile credential exists", async () => {
    // Bootstrap case: auth profile store exists but profile is not yet populated.
    // Local credential must still be used to form the epoch.
    let access = "local-access-a";
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access,
        refresh: "local-refresh",
        expires: 1,
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "claude-cli",
      authProfileId: "anthropic:work",
    });
    expectCliAuthEpoch(first);

    // When no profile credential is present, local credential is the epoch source.
    // But token rotation (access/refresh only) should not shift it for oauth.
    access = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "claude-cli",
      authProfileId: "anthropic:work",
    });
    expect(second).toBe(first);
  });

  it("uses non-prompting Codex CLI credential reads for epoch fingerprints", async () => {
    const readCodexCliCredentialsCached = vi.fn(() => ({
      type: "oauth" as const,
      provider: "openai-codex" as const,
      access: "local-access",
      refresh: "local-refresh",
      expires: 1,
    }));
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await resolveCliAuthEpoch({ provider: "codex-cli" });

    expect(readCodexCliCredentialsCached).toHaveBeenCalledWith({
      ttlMs: 5000,
      allowKeychainPrompt: false,
    });
  });
});
