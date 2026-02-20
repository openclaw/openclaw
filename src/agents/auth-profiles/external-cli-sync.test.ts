import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function makeStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

function makeClaudeOAuth(expires: number): OAuthCredential {
  return {
    type: "oauth",
    provider: "anthropic",
    access: "new-access",
    refresh: "new-refresh",
    expires,
  };
}

describe("syncExternalCliCredentials (Anthropic)", () => {
  const now = 1_700_000_000_000;

  const readQwenCliCredentialsCached = vi.fn();
  const readMiniMaxCliCredentialsCached = vi.fn();
  const readClaudeCliCredentialsCached = vi.fn();

  const deps = {
    readQwenCliCredentialsCached,
    readMiniMaxCliCredentialsCached,
    readClaudeCliCredentialsCached,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    readQwenCliCredentialsCached.mockReset();
    readMiniMaxCliCredentialsCached.mockReset();
    readClaudeCliCredentialsCached.mockReset();
    readQwenCliCredentialsCached.mockReturnValue(null);
    readMiniMaxCliCredentialsCached.mockReturnValue(null);
    readClaudeCliCredentialsCached.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not recreate deprecated anthropic:claude-cli profile", () => {
    readClaudeCliCredentialsCached.mockReturnValue(makeClaudeOAuth(now + 60_000));
    const store = makeStore({});

    const mutated = syncExternalCliCredentials(store, deps);

    expect(mutated).toBe(false);
    expect(store.profiles["anthropic:claude-cli"]).toBeUndefined();
    expect(readClaudeCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("does not overwrite anthropic:default api_key profile with oauth", () => {
    readClaudeCliCredentialsCached.mockReturnValue(makeClaudeOAuth(now + 60_000));
    const store = makeStore({
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-api-key",
      },
    });

    const mutated = syncExternalCliCredentials(store, deps);

    expect(mutated).toBe(false);
    expect(store.profiles["anthropic:default"]).toEqual({
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-api-key",
    });
    expect(readClaudeCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("does not overwrite anthropic:default token profile with oauth", () => {
    readClaudeCliCredentialsCached.mockReturnValue(makeClaudeOAuth(now + 60_000));
    const store = makeStore({
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        token: "sk-ant-oat01-user-token",
        expires: now + 60_000,
      },
    });

    const mutated = syncExternalCliCredentials(store, deps);

    expect(mutated).toBe(false);
    expect(store.profiles["anthropic:default"]).toEqual({
      type: "token",
      provider: "anthropic",
      token: "sk-ant-oat01-user-token",
      expires: now + 60_000,
    });
    expect(readClaudeCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("refreshes anthropic:default when existing profile is oauth and stale", () => {
    readClaudeCliCredentialsCached.mockReturnValue(makeClaudeOAuth(now + 3_600_000));
    const store = makeStore({
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "old-access",
        refresh: "old-refresh",
        expires: now - 1_000,
      },
    });

    const mutated = syncExternalCliCredentials(store, deps);

    expect(mutated).toBe(true);
    expect(store.profiles["anthropic:default"]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "new-access",
      refresh: "new-refresh",
      expires: now + 3_600_000,
    });
    expect(readClaudeCliCredentialsCached).toHaveBeenCalledTimes(1);
  });

  it("does not refresh anthropic:default when existing oauth profile is still fresh", () => {
    readClaudeCliCredentialsCached.mockReturnValue(makeClaudeOAuth(now + 3_600_000));
    const store = makeStore({
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "existing-access",
        refresh: "existing-refresh",
        expires: now + 60 * 60 * 1000,
      },
    });

    const mutated = syncExternalCliCredentials(store, deps);

    expect(mutated).toBe(false);
    expect(store.profiles["anthropic:default"]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "existing-access",
      refresh: "existing-refresh",
      expires: now + 60 * 60 * 1000,
    });
    expect(readClaudeCliCredentialsCached).not.toHaveBeenCalled();
  });
});
