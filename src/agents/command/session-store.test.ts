import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

describe("updateSessionStoreAfterAgentRun", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists claude-cli session bindings when the backend is configured", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-claude-cli";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "cli-session-123",
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          cliSessionBinding: {
            sessionId: "cli-session-123",
          },
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "claude-cli",
      defaultModel: "claude-sonnet-4-6",
      result,
    });

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-123",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-123",
    });
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
    expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
  });

  it("clears reset CLI import suppression when a new CLI binding is persisted", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-codex-cli";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
        suppressCliHistoryImport: true,
        cliSessionBindings: {
          "codex-cli": {
            sessionId: "stale-session",
          },
        },
        cliSessionIds: {
          "codex-cli": "stale-session",
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "cli-session-456",
          provider: "codex-cli",
          model: "gpt-5.4",
          cliSessionBinding: {
            sessionId: "cli-session-456",
          },
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "codex-cli",
      defaultModel: "gpt-5.4",
      result,
    });

    expect(sessionStore[sessionKey]?.suppressCliHistoryImport).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "cli-session-456",
    });

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.suppressCliHistoryImport).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "cli-session-456",
    });
  });

  it("keeps reset CLI import suppression when the preserved CLI session is reused", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-codex-cli-reuse";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
        suppressCliHistoryImport: true,
        cliSessionBindings: {
          "codex-cli": {
            sessionId: "preserved-session",
          },
        },
        cliSessionIds: {
          "codex-cli": "preserved-session",
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "preserved-session",
          provider: "codex-cli",
          model: "gpt-5.4",
          cliSessionBinding: {
            sessionId: "preserved-session",
          },
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "codex-cli",
      defaultModel: "gpt-5.4",
      result,
    });

    expect(sessionStore[sessionKey]?.suppressCliHistoryImport).toBe(true);

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.suppressCliHistoryImport).toBe(true);
    expect(persisted[sessionKey]?.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "preserved-session",
    });
  });
});
