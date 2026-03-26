import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

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

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
    usageStats: {
      "anthropic:default": {
        disabledUntil: Date.now() + 60_000,
        disabledReason: "auth_permanent",
        errorCount: 3,
        failureCounts: { auth_permanent: 3 },
      },
    },
  };
}

describe("syncExternalCliCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
    mocks.readQwenCliCredentialsCached.mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(null);
  });

  it("syncs Claude CLI OAuth credentials into anthropic:default and clears stale auth failures", () => {
    const store = makeStore();
    const expires = Date.now() + 60 * 60 * 1000;
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-access",
      refresh: "claude-refresh",
      expires,
    });

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles["anthropic:default"]).toEqual({
      type: "oauth",
      provider: "anthropic",
      access: "claude-access",
      refresh: "claude-refresh",
      expires,
    });
    expect(store.usageStats?.["anthropic:default"]).toMatchObject({
      errorCount: 0,
      cooldownUntil: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      failureCounts: undefined,
    });
  });
});
