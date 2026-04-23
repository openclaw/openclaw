import { afterEach, describe, expect, it } from "vitest";
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

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
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

  it("keeps claude cli oauth epochs stable across access-token refreshes", async () => {
    let access = "access-a";
    let expires = 1;
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access,
        refresh: "refresh",
        expires,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    access = "access-b";
    expires = 2;
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("changes claude cli oauth epochs when the refresh token changes", async () => {
    let refresh = "refresh-a";
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh,
        expires: 1,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    refresh = "refresh-b";
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("keeps oauth auth-profile epochs stable across access-token refreshes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh",
          expires: 1,
        },
      },
    };
    setCliAuthEpochTestDeps({
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
          refresh: "refresh",
          expires: 2,
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("changes oauth auth-profile epochs when the refresh token changes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh-a",
          expires: 1,
        },
      },
    };
    setCliAuthEpochTestDeps({
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
          refresh: "refresh-b",
          expires: 1,
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("mixes local codex and auth-profile state", async () => {
    let access = "local-access-a";
    let localRefresh = "local-refresh-a";
    let refresh = "profile-refresh-a";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh: localRefresh,
        expires: 1,
        accountId: "acct-1",
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "profile-access",
            refresh,
            expires: 1,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    access = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    localRefresh = "local-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    refresh = "profile-refresh-b";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });

    expect(first).toBeDefined();
    expect(third).toBeDefined();
    expect(fourth).toBeDefined();
    expect(second).toBe(first);
    expect(third).not.toBe(second);
    expect(fourth).not.toBe(third);
  });

  it("can ignore local codex state when the backend is profile-owned", async () => {
    let localAccess = "local-access-a";
    let profileRefresh = "profile-refresh-a";
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
            accountId: "acct-1",
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

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(third).toBeDefined();
    expect(third).not.toBe(second);
  });
});
