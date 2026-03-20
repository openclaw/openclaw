import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn(() => null),
  readMiniMaxCliCredentialsCached: vi.fn(() => null),
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
  readQwenCliCredentialsCached: mocks.readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
}));

const { syncExternalCliCredentials } = await import("./auth-profiles/external-cli-sync.js");
const { CODEX_CLI_PROFILE_ID } = await import("./auth-profiles/constants.js");

const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";

describe("syncExternalCliCredentials", () => {
  it("syncs Codex CLI credentials into the supported default auth profile", () => {
    const expires = Date.now() + 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires,
      accountId: "acct_123",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: expect.any(Number) }),
    );
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires,
      accountId: "acct_123",
    });
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toBeUndefined();
  });

  it("refreshes stored Codex expiry from external CLI even when the cached profile looks fresh", () => {
    const staleExpiry = Date.now() + 30 * 60_000;
    const freshExpiry = Date.now() + 5 * 24 * 60 * 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "new-access-token",
      refresh: "new-refresh-token",
      expires: freshExpiry,
      accountId: "acct_456",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "old-access-token",
          refresh: "old-refresh-token",
          expires: staleExpiry,
          accountId: "acct_456",
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      access: "new-access-token",
      refresh: "new-refresh-token",
      expires: freshExpiry,
    });
  });
});
