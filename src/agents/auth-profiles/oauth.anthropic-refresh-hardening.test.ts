import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

/**
 * Tests for Anthropic OAuth refresh hardening (2026-03-25):
 * - Fix 1: Preserve refresh token when response omits it
 * - Fix 2: Clear failure state after successful refresh/adoption
 * - Fix 3: Freshness guard in external CLI sync
 * - Fix 4: Subagent merge prefers fresher OAuth credentials
 */

// ---- Fix 3: Freshness guard in external CLI sync ----

const mocks = vi.hoisted(() => ({
  readClaudeCliCredentialsCached: vi.fn(),
  readCodexCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn(),
  readMiniMaxCliCredentialsCached: vi.fn(),
}));

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: mocks.readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
  readQwenCliCredentialsCached: mocks.readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
}));

import { syncExternalCliCredentials } from "./external-cli-sync.js";

function makeOAuthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "anthropic",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 6 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("external CLI sync freshness guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
    mocks.readQwenCliCredentialsCached.mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(null);
  });

  it("does not overwrite store credentials when store has a later expiry", () => {
    const now = Date.now();
    const storeExpiry = now + 6 * 60 * 60 * 1000; // 6h (fresher)
    const cliExpiry = now + 2 * 60 * 60 * 1000; // 2h (stale)

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": makeOAuthCredential({
          access: "store-fresh",
          expires: storeExpiry,
        }),
      },
    };

    mocks.readClaudeCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({ access: "cli-stale", expires: cliExpiry }),
    );

    const mutated = syncExternalCliCredentials(store, { log: false });
    expect(mutated).toBe(false);
    expect((store.profiles["anthropic:default"] as OAuthCredential).access).toBe("store-fresh");
  });

  it("overwrites store credentials when CLI has a later expiry", () => {
    const now = Date.now();
    const storeExpiry = now + 2 * 60 * 60 * 1000; // 2h (stale)
    const cliExpiry = now + 6 * 60 * 60 * 1000; // 6h (fresher)

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": makeOAuthCredential({
          access: "store-stale",
          expires: storeExpiry,
        }),
      },
    };

    mocks.readClaudeCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({ access: "cli-fresh", expires: cliExpiry }),
    );

    const mutated = syncExternalCliCredentials(store, { log: false });
    expect(mutated).toBe(true);
    expect((store.profiles["anthropic:default"] as OAuthCredential).access).toBe("cli-fresh");
  });

  it("still clears failure state when store has fresher creds but failure state exists", () => {
    const now = Date.now();
    const storeExpiry = now + 6 * 60 * 60 * 1000;
    const cliExpiry = now + 2 * 60 * 60 * 1000;

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": makeOAuthCredential({ expires: storeExpiry }),
      },
      usageStats: {
        "anthropic:default": {
          disabledUntil: now + 60_000,
          disabledReason: "auth_permanent",
          errorCount: 3,
          failureCounts: { auth_permanent: 3 },
        },
      },
    };

    mocks.readClaudeCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({ expires: cliExpiry }),
    );

    const mutated = syncExternalCliCredentials(store, { log: false });
    // Mutated because failure state was cleared, even though creds were not overwritten
    expect(mutated).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.disabledReason).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
  });
});

// ---- Fix 4: Subagent merge prefers fresher OAuth credentials ----

// First dynamic import of ./store.js inside these tests triggers a full auth-profile
// module graph load. On cold CI shards that exceeds the default 120s timeout on the
// first test; follow-ups are instant because the module is cached. 300s headroom.
describe("subagent merge freshness", { timeout: 300_000 }, () => {
  it("prefers base OAuth credential when it has a later expiry than override", async () => {
    // We access mergeAuthProfileStores indirectly through runtime snapshots
    const {
      replaceRuntimeAuthProfileStoreSnapshots,
      clearRuntimeAuthProfileStoreSnapshots,
      ensureAuthProfileStore,
    } = await import("./store.js");

    const now = Date.now();
    const mainExpiry = now + 6 * 60 * 60 * 1000; // fresher
    const subagentExpiry = now + 1 * 60 * 60 * 1000; // stale

    const testAgentDir = "/tmp/test-subagent-merge-" + Date.now();

    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: undefined,
        store: {
          version: 1,
          profiles: {
            "anthropic:default": makeOAuthCredential({
              access: "main-fresh",
              expires: mainExpiry,
            }),
          },
        },
      },
      {
        agentDir: testAgentDir,
        store: {
          version: 1,
          profiles: {
            "anthropic:default": makeOAuthCredential({
              access: "subagent-stale",
              expires: subagentExpiry,
            }),
          },
        },
      },
    ]);

    const merged = ensureAuthProfileStore(testAgentDir);
    expect((merged.profiles["anthropic:default"] as OAuthCredential).access).toBe("main-fresh");
    expect((merged.profiles["anthropic:default"] as OAuthCredential).expires).toBe(mainExpiry);

    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("prefers override when override has a later expiry", async () => {
    const {
      replaceRuntimeAuthProfileStoreSnapshots,
      clearRuntimeAuthProfileStoreSnapshots,
      ensureAuthProfileStore,
    } = await import("./store.js");

    const now = Date.now();
    const mainExpiry = now + 1 * 60 * 60 * 1000; // stale
    const subagentExpiry = now + 6 * 60 * 60 * 1000; // fresher

    const testAgentDir = "/tmp/test-subagent-merge-fresh-" + Date.now();

    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: undefined,
        store: {
          version: 1,
          profiles: {
            "anthropic:default": makeOAuthCredential({
              access: "main-stale",
              expires: mainExpiry,
            }),
          },
        },
      },
      {
        agentDir: testAgentDir,
        store: {
          version: 1,
          profiles: {
            "anthropic:default": makeOAuthCredential({
              access: "subagent-fresh",
              expires: subagentExpiry,
            }),
          },
        },
      },
    ]);

    const merged = ensureAuthProfileStore(testAgentDir);
    expect((merged.profiles["anthropic:default"] as OAuthCredential).access).toBe("subagent-fresh");

    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("uses override for non-OAuth profiles regardless of expiry", async () => {
    const {
      replaceRuntimeAuthProfileStoreSnapshots,
      clearRuntimeAuthProfileStoreSnapshots,
      ensureAuthProfileStore,
    } = await import("./store.js");

    const testAgentDir = "/tmp/test-subagent-merge-apikey-" + Date.now();

    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: undefined,
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "main-key",
            },
          },
        },
      },
      {
        agentDir: testAgentDir,
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "subagent-key",
            },
          },
        },
      },
    ]);

    const merged = ensureAuthProfileStore(testAgentDir);
    expect(merged.profiles["openai:default"]).toMatchObject({ key: "subagent-key" });

    clearRuntimeAuthProfileStoreSnapshots();
  });
});
