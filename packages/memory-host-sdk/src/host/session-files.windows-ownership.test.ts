// Memory transcript owners follow filesystem casing without crossing agents.
import fsSync from "node:fs";
import path from "node:path";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../../src/plugin-sdk/sqlite-runtime-testing.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  extractAgentIdFromSessionsDir,
  resolveSessionTranscriptsDirForAgent,
} from "./openclaw-runtime-session.js";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  sessionPathForFile,
} from "./session-files.js";

function fixturePath(...parts: string[]): string {
  return path.resolve(resolveSessionTranscriptsDirForAgent("main"), "../../..", ...parts);
}

describe("memory session directory ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("includes the owning agent id in canonical archived transcript paths", () => {
    const name = "deleted-session.jsonl.deleted.2026-02-16T22-27-33.000Z";
    const sessionFile = fixturePath("agents", "main", "sessions", name);
    expect(sessionPathForFile(sessionFile)).toBe(
      "sessions/main/deleted-session.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
  });

  it("keeps case-variant structural segments unowned on case-sensitive platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(extractAgentIdFromSessionsDir(fixturePath("AGENTS", "Main", "SESSIONS"))).toBeNull();
  });

  it("preserves case-variant Windows ownership in logical transcript paths", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const sessionFile = fixturePath("AGENTS", "Main", "SESSIONS", "active.jsonl");
    expect(sessionPathForFile(sessionFile)).toBe("sessions/main/active.jsonl");
    expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toEqual({
      agentId: "main",
      sessionId: "active",
    });
  });

  it("finds the canonical owner past a nested case-variant sessions directory", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const sessionFile = fixturePath(
      "agents",
      "main",
      "sessions",
      "archive",
      "SESSIONS",
      "active.jsonl",
    );
    expect(sessionPathForFile(sessionFile)).toBe("sessions/main/active.jsonl");
  });

  it("preserves canonical SQLite session identity on Windows", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDirs = createTempDirTracker();
    const tmpDir = fsSync.realpathSync.native(tempDirs.make("session-windows-ownership-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await captureRuntimeConfigAsyncReader()();

      const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:chat:windows-transcript";
      fsSync.mkdirSync(sessionsDir, { recursive: true });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "active", updatedAt: 1 },
      );

      await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
        expect.objectContaining({
          agentId: "main",
          sessionFile: sessionKey,
          sessionId: "active",
          transcriptSource: "sqlite",
        }),
      );
    } finally {
      platform.mockRestore();
      // Agent close releases leases through shared state; close agent handles first while the
      // fixture env is active, then close shared state before removing the Windows-owned directory.
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      tempDirs.cleanup();
    }
  });

  it.each(["bad owner", " Main"])(
    "never aliases an invalid Windows session owner into another agent: %s",
    (owner) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const sessionsDir = fixturePath("agents", owner, "sessions");
      const sessionFile = path.join(sessionsDir, "active.jsonl");
      expect(extractAgentIdFromSessionsDir(sessionsDir)).toBeNull();
      expect(sessionPathForFile(sessionFile)).toBe("sessions/active.jsonl");
      expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toBeNull();
    },
  );
});
