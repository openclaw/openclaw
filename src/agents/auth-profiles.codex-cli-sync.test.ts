import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION, CODEX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn().mockReturnValue(null),
  readMiniMaxCliCredentialsCached: vi.fn().mockReturnValue(null),
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
  readQwenCliCredentialsCached: mocks.readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
}));

const { syncExternalCliCredentials } = await import("./auth-profiles/external-cli-sync.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("codex CLI credential sync", () => {
  it("syncs Codex CLI credentials into the auth store when no profile exists", () => {
    const now = Date.now();
    const codexCreds = {
      type: "oauth" as const,
      provider: "openai-codex" as const,
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: now + 60 * 60 * 1000,
    };
    mocks.readCodexCliCredentialsCached.mockReturnValue(codexCreds);

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
    });
  });

  it("does not sync when Codex CLI credentials are unavailable", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toBeUndefined();
  });

  it("updates stale Codex CLI credentials with fresher ones", () => {
    const now = Date.now();
    const freshCreds = {
      type: "oauth" as const,
      provider: "openai-codex" as const,
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: now + 2 * 60 * 60 * 1000,
    };
    mocks.readCodexCliCredentialsCached.mockReturnValue(freshCreds);

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [CODEX_CLI_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-access-token",
          refresh: "stale-refresh-token",
          expires: now - 60 * 1000, // expired
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toMatchObject({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
    });
  });

  it("skips sync when existing Codex profile is still fresh", () => {
    const now = Date.now();
    const existingCreds = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "existing-access",
      refresh: "existing-refresh",
      expires: now + 60 * 60 * 1000, // 1 hour from now, well within freshness
    };

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [CODEX_CLI_PROFILE_ID]: existingCreds,
      },
    };

    const mutated = syncExternalCliCredentials(store);

    // readCodexCliCredentialsCached should not be called because profile is fresh
    expect(mutated).toBe(false);
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toMatchObject({
      access: "existing-access",
    });
  });

  it("syncs Codex credentials with accountId metadata", () => {
    const now = Date.now();
    const codexCreds = {
      type: "oauth" as const,
      provider: "openai-codex" as const,
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: now + 60 * 60 * 1000,
      accountId: "user-123",
    };
    mocks.readCodexCliCredentialsCached.mockReturnValue(codexCreds);

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access-token",
      accountId: "user-123",
    });
  });
});
