import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "./cli-compaction.js";

function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
  afterTurnCalls?: Array<Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]>;
  afterTurnThrows?: boolean;
}): ContextEngine {
  const engine: ContextEngine = {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
  if (params.afterTurnCalls) {
    engine.afterTurn = async (afterTurnParams) => {
      params.afterTurnCalls?.push(afterTurnParams);
      if (params.afterTurnThrows) {
        throw new Error("simulated ingest failure");
      }
    };
  }
  return engine;
}

async function writeSessionFile(params: { sessionFile: string; sessionId: string }) {
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  await fs.writeFile(
    params.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: path.dirname(params.sessionFile),
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "old ask", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
  });

  afterEach(async () => {
    resetCliCompactionTestDeps();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compacts over-budget CLI transcripts and clears external CLI resume state", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const storePath = path.join(tmpDir, "sessions.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session",
      },
      claudeCliSessionId: "claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 1_000,
      currentTokenCount: 950,
      force: true,
      compactionTarget: "budget",
    });
    expect(maintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "compaction",
        sessionId,
        sessionKey,
        sessionFile,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("ingests the just-completed CLI turn into the context engine via afterTurn", async () => {
    const sessionKey = "agent:main:cli";
    // Use SessionManager.create + appendMessage so the on-disk file is
    // SessionManager-readable. writeSessionFile() above produces a format
    // the existing compaction test tolerates only because that test mocks the
    // message-consuming code path; my ingest path actually reads getBranch().
    const sm = SessionManager.create(tmpDir, tmpDir);
    sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 2,
    });
    const sessionFile = sm.getSessionFile();
    const sessionId = sm.getSessionId();

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 100,
      totalTokensFresh: true,
    };

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const afterTurnCalls: Array<Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]> = [];
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls, afterTurnCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      // No compaction needed (under budget).
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 100,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: vi.fn(),
    });

    await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    // Ingest must run regardless of compaction outcome.
    expect(afterTurnCalls).toHaveLength(1);
    expect(afterTurnCalls[0]).toMatchObject({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 1_000,
    });
    // Two messages on disk; prePromptMessageCount = 0 means both are "new"
    // (writeSessionFile created exactly the user prompt + assistant reply).
    expect(afterTurnCalls[0]?.messages).toHaveLength(2);
    expect(afterTurnCalls[0]?.prePromptMessageCount).toBe(0);
    // No compaction this turn — under budget.
    expect(compactCalls).toHaveLength(0);
  });

  it("ingests even when contextTokens budget is unset (skips compaction but feeds the engine)", async () => {
    const sessionKey = "agent:main:cli";
    const sm = SessionManager.create(tmpDir, tmpDir);
    sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 2,
    });
    const sessionFile = sm.getSessionFile();
    const sessionId = sm.getSessionId();

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      // contextTokens deliberately omitted — no compaction will run.
    };

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const afterTurnCalls: Array<Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]> = [];
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls, afterTurnCalls }),
    });

    await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    // Ingest fires even with no token budget configured.
    expect(afterTurnCalls).toHaveLength(1);
    // Compaction is skipped (no budget).
    expect(compactCalls).toHaveLength(0);
  });

  it("does not crash when afterTurn throws — ingest failure must not break the CLI return path", async () => {
    const sessionKey = "agent:main:cli";
    const sm = SessionManager.create(tmpDir, tmpDir);
    sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 2,
    });
    const sessionFile = sm.getSessionFile();
    const sessionId = sm.getSessionId();

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
    };

    const afterTurnCalls: Array<Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]> = [];
    setCliCompactionTestDeps({
      resolveContextEngine: async () =>
        buildContextEngine({ compactCalls: [], afterTurnCalls, afterTurnThrows: true }),
    });

    // Should resolve without throwing.
    await expect(
      runCliTurnCompactionLifecycle({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        sessionEntry,
        sessionAgentId: "main",
        workspaceDir: tmpDir,
        agentDir: tmpDir,
        provider: "claude-cli",
        model: "opus",
      }),
    ).resolves.not.toThrow();

    expect(afterTurnCalls).toHaveLength(1);
  });

  it("skips ingest when context engine has no afterTurn implementation", async () => {
    const sessionKey = "agent:main:cli";
    const sm = SessionManager.create(tmpDir, tmpDir);
    sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 2,
    });
    const sessionFile = sm.getSessionFile();
    const sessionId = sm.getSessionId();

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
    };

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    setCliCompactionTestDeps({
      // No afterTurnCalls => engine returned has no afterTurn method.
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
    });

    await expect(
      runCliTurnCompactionLifecycle({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        sessionEntry,
        sessionAgentId: "main",
        workspaceDir: tmpDir,
        agentDir: tmpDir,
        provider: "claude-cli",
        model: "opus",
      }),
    ).resolves.not.toThrow();
    // Compaction is skipped (no budget) and afterTurn doesn't exist — no calls anywhere.
    expect(compactCalls).toHaveLength(0);
  });
});
