import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
  terminalTranscriptNewer: false,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntries: () =>
    Object.entries(hoisted.store).map(([sessionKey, entry]) => ({
      sessionKey,
      entry,
    })),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: () => "/stores/main.json",
}));

vi.mock("../../config/sessions/lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/lifecycle.js")>(
    "../../config/sessions/lifecycle.js",
  );
  return {
    ...actual,
    hasTerminalMainSessionTranscriptNewerThanRegistrySync: () => hoisted.terminalTranscriptNewer,
  };
});

const { resolveSession } = await import("./session.js");

const DAY_MS = 24 * 60 * 60 * 1000;

function seedProviderOwned(sessionKey: string): void {
  const startedAt = Date.now() - DAY_MS;
  hoisted.store = {
    [sessionKey]: {
      sessionId: "old-session-id",
      updatedAt: startedAt,
      sessionStartedAt: startedAt,
      lastInteractionAt: startedAt,
      model: "claude-opus-4-6",
      modelProvider: "claude-cli",
      cliSessionBindings: { "claude-cli": { sessionId: "cli-conversation-xyz" } },
    },
  };
}

describe("command resolveSession provider-owned daily reset", () => {
  beforeEach(() => {
    hoisted.terminalTranscriptNewer = false;
  });

  it("keeps a provider-owned CLI session across the default daily boundary", () => {
    const sessionKey = "agent:main:cli";
    seedProviderOwned(sessionKey);

    const result = resolveSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("old-session-id");
  });

  it("still rotates a non-provider-owned session across the daily boundary", () => {
    const sessionKey = "agent:main:cli";
    const startedAt = Date.now() - DAY_MS;
    hoisted.store = {
      [sessionKey]: {
        sessionId: "old-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
      },
    };

    const result = resolveSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("old-session-id");
  });

  it("keeps a model-locked session across the daily boundary", () => {
    const sessionKey = "agent:main:codex-supervised";
    const startedAt = Date.now() - DAY_MS;
    hoisted.store = {
      [sessionKey]: {
        sessionId: "locked-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    hoisted.terminalTranscriptNewer = true;

    const result = resolveSession({
      cfg: { session: {} } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("locked-session-id");
  });

  it("keeps a fresh session when the terminal transcript gate fires but the entry is still fresh under an idle policy", () => {
    const sessionKey = "agent:main:cli";
    const startedAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago — well within idle window
    hoisted.store = {
      [sessionKey]: {
        sessionId: "fresh-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        endedAt: startedAt + 1000,
        status: "done",
      },
    };
    hoisted.terminalTranscriptNewer = true;

    const result = resolveSession({
      cfg: { session: { reset: { mode: "idle", idleMinutes: 30 } } } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    // The session is fresh under the configured idle policy (5 min < 30 min).
    // The terminal transcript gate should not override this.
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("fresh-session-id");
  });

  it("rotates a stale session when the terminal transcript gate fires on an idle-expired entry", () => {
    const sessionKey = "agent:main:cli";
    const startedAt = Date.now() - 60 * 60 * 1000; // 60 minutes ago — past the idle window
    hoisted.store = {
      [sessionKey]: {
        sessionId: "stale-session-id",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        endedAt: startedAt + 1000,
        status: "done",
      },
    };
    hoisted.terminalTranscriptNewer = true;

    const result = resolveSession({
      cfg: { session: { reset: { mode: "idle", idleMinutes: 30 } } } as OpenClawConfig,
      sessionKey,
      agentId: "main",
    });

    // The session is stale under the configured idle policy (60 min > 30 min).
    // The terminal transcript gate fires and the session should be rotated.
    expect(result.isNewSession).toBe(true);
  });
});
