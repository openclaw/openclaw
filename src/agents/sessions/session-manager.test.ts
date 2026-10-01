import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as configEnv from "../../config/config-env-vars.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  readTranscriptRawDelta,
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);

function createScope(sessionId: string) {
  const dir = tempDirs.make("openclaw-session-manager-");
  return {
    dir,
    scope: {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(dir, "sessions.json"),
    },
  };
}

function sessionHeader(id: string, cwd: string, version = CURRENT_SESSION_VERSION) {
  return { type: "session" as const, version, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function openMarker(marker: string, sessionKey: string, cwd: string): SessionManager {
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  return SessionManager.open({ ...target, sessionKey }, cwd);
}

describe("SessionManager.open", () => {
  it("commits ordered metadata with Windows environment semantics off-thread", async () => {
    const { dir, scope: target } = createScope("metadata-worker");
    target.storePath = path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const manager = SessionManager.open(target, dir);
    // Preserve the implementation so each observed call uses its actual database receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const nativePrepare = DatabaseSync.prototype.prepare;
    const hostWrites: string[] = [];
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const mutation = /^\s*(insert|update|delete|replace)\b/i.exec(sql)?.[1];
      if (mutation && /\b(?:transcript_events|session_windows|session_nodes)\b/i.test(sql)) {
        hostWrites.push(mutation);
      }
      return nativePrepare.call(this, sql);
    });
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    const clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((env) => {
      const { OPENCLAW_STATE_DIR, ...rest } = env;
      const captured = withMockedPlatform("win32", () =>
        cloneEnv({
          ...rest,
          OpenClaw_State_Dir: OPENCLAW_STATE_DIR,
        }),
      );
      expect(() => serialize(captured)).toThrow("could not be cloned");
      return captured;
    });
    let ids: string[];
    try {
      ids = await Promise.all([
        manager.appendModelChange("test-provider", "test-model"),
        manager.appendThinkingLevelChange("high"),
      ]);
    } finally {
      prepare.mockRestore();
      clone.mockRestore();
    }
    expect(hostWrites).toEqual([]);
    expect(manager.getEntries()).toMatchObject([
      {
        type: "model_change",
        id: ids[0],
        parentId: null,
        provider: "test-provider",
        modelId: "test-model",
      },
      { type: "thinking_level_change", id: ids[1], parentId: ids[0], thinkingLevel: "high" },
    ]);
    expect(SessionManager.open(target, dir).getEntries()).toEqual(manager.getEntries());
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
  });

  it("opens SQLite markers without creating marker-named files and persists assistant replies", async () => {
    const { dir, scope } = createScope("sqlite-session");
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntryCore(scope, {
      sessionFile: marker,
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      message: { role: "user", content: "question" },
    });
    const manager = openMarker(marker, scope.sessionKey, dir);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { content: "question", role: "user" },
    ]);
    const assistantId = manager.appendMessage(buildAssistantMessage("answer"));
    const thinkingId = await manager.appendThinkingLevelChange("high");
    const modelId = await manager.appendModelChange("openai", "gpt-5.5");
    const compactionId = manager.appendCompaction("summary", "assistant-1", 42);
    const resetId = manager.appendResetBoundary("new", assistantId);
    expect(manager.getBoundaryCount()).toBe(2);
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toMatchObject([
      { type: "session" },
      { type: "message", message: { content: "question", role: "user" } },
      {
        type: "message",
        id: assistantId,
        parentId: expect.any(String),
        message: { content: [{ type: "text", text: "answer" }], role: "assistant" },
      },
      { type: "thinking_level_change", id: thinkingId, thinkingLevel: "high" },
      { type: "model_change", id: modelId, modelId: "gpt-5.5", provider: "openai" },
      { type: "compaction", id: compactionId, firstKeptEntryId: "assistant-1", summary: "summary" },
      { type: "reset", id: resetId, firstKeptEntryId: assistantId, reason: "new" },
    ]);
    expect(openMarker(marker, scope.sessionKey, dir).getEntries()).toEqual(manager.getEntries());
  });

  it("rejects persisted legacy transcripts until doctor or import migrates them", async () => {
    const { dir, scope } = createScope("legacy-persisted-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(scope, [
      sessionHeader(scope.sessionId, dir, 1),
      {
        type: "message",
        message: { role: "user", content: "legacy message" },
      },
    ]);

    expect(() => SessionManager.open(scope, dir)).toThrow(
      "require doctor/import migration before runtime use",
    );
    const existingManager = SessionManager.inMemory("/original-workspace");
    expect(() => existingManager.setSessionTarget(scope)).toThrow(
      "require doctor/import migration before runtime use",
    );
    expect(existingManager.getCwd()).toBe("/original-workspace");

    const currentScope = {
      ...scope,
      sessionId: "current-persisted-session",
      sessionKey: "agent:main:current-persisted-session",
    };
    await upsertSessionEntryCore(currentScope, { sessionId: currentScope.sessionId, updatedAt: 2 });
    const currentManager = SessionManager.open(currentScope, dir);
    expect(() => currentManager.setSessionTarget(scope)).toThrow(
      "require doctor/import migration before runtime use",
    );
    await currentManager.appendModelChange("test-provider", "test-model");
    await expect(loadTranscriptEvents(currentScope)).resolves.toEqual([
      expect.objectContaining({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: currentScope.sessionId,
      }),
      expect.objectContaining({ type: "model_change" }),
    ]);
  });

  it("does not overwrite a rebound session row when the first append seeds its header", async () => {
    const { dir, scope } = createScope("sqlite-stale-appender");
    await upsertSessionEntryCore(scope, {
      sessionId: "sqlite-current-owner",
      updatedAt: 456,
      label: "preserved",
    });
    const before = loadSessionEntry(scope);
    const manager = SessionManager.open(scope, dir);

    expect(() =>
      manager.appendMessage({ role: "user", content: "stale message", timestamp: 1 }),
    ).toThrow("Session transcript header was not persisted");
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it("rejects invalid entries before mutating in-memory state", async () => {
    const manager = SessionManager.inMemory("/tmp");
    const entriesBefore = manager.getEntries();

    await expect(manager.appendModelChange("", "")).rejects.toThrow(
      "Invalid session transcript entry",
    );
    expect(manager.getEntries()).toEqual(entriesBefore);
    expect(manager.getLeafId()).toBeNull();
    expect(manager.getAppendParentId()).toBeNull();
  });

  it("uses the selected logical leaf immediately after a side append control", () => {
    const manager = SessionManager.inMemory("/tmp");
    const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
    const control = manager.appendLeafControl({
      targetId: firstId,
      appendParentId: secondId,
      appendMode: "side",
    });

    const thirdId = manager.appendMessage({ role: "user", content: "third", timestamp: 3 });

    expect(manager.getBranch().map((entry) => entry.id)).toEqual([firstId, thirdId]);
    manager.branch(control.id);
    expect(manager.getLeafId()).toBe(firstId);
    expect(() =>
      manager.appendLeafControl({
        targetId: thirdId,
        appendParentId: "missing-parent",
      }),
    ).toThrow("Append parent missing-parent not found");
  });

  it("refreshes cwd when switching persisted targets and rejects identity reset", async () => {
    const { dir, scope: firstTarget } = createScope("first-target");
    const secondTarget = {
      ...firstTarget,
      sessionId: "second-target",
      sessionKey: "agent:main:second-target",
    };
    await upsertSessionEntryCore(firstTarget, { sessionId: firstTarget.sessionId, updatedAt: 1 });
    await upsertSessionEntryCore(secondTarget, { sessionId: secondTarget.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(firstTarget, {
      cwd: path.join(dir, "first-workspace"),
      message: { role: "user", content: "first" },
    });
    replaceTranscriptEventsSync(secondTarget, [
      null,
      sessionHeader(secondTarget.sessionId, path.join(dir, "second-workspace")),
    ]);

    const manager = SessionManager.open(firstTarget);
    const leaf = manager.getLeafId();
    manager.appendLeafControl({ targetId: leaf, appendParentId: leaf, appendMode: "side" });
    manager.setSessionTarget(secondTarget);
    expect(manager.getAppendMode()).toBeUndefined();

    expect(manager.getCwd()).toBe(path.join(dir, "second-workspace"));
    expect(() => manager.newSession()).toThrow(
      "Persisted session managers cannot change session identity in place",
    );
  });

  it("does not mutate frozen caller entries during in-memory migration", () => {
    const entries = [
      null,
      Object.freeze(sessionHeader("frozen-legacy-session", "/tmp", 2)),
      Object.freeze({
        type: "message" as const,
        id: "frozen-legacy-hook",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: Object.freeze({ role: "hookMessage", content: "frozen hook context" }),
      }),
    ] as const;

    const manager = SessionManager.fromEntries(Object.freeze(entries));

    expect(manager.getEntry("frozen-legacy-hook")).toMatchObject({
      message: { role: "custom", customType: "hook", content: "frozen hook context" },
    });
    expect(entries[2].message).toEqual({
      role: "hookMessage",
      content: "frozen hook context",
    });
  });

  it("keeps stale appenders valid across a reset while snapshot replacement rotates generation", async () => {
    const { dir, scope } = createScope("sqlite-reset-stale-appender");
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntryCore(scope, {
      sessionFile: marker,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      eventId: "initial-user",
      message: { role: "user", content: "before reset" },
      parentId: null,
    });
    const cursor = readTranscriptRawDelta(scope);
    expect(cursor.kind).toBe("page");
    if (cursor.kind !== "page") {
      throw new Error("expected initial raw cursor page");
    }

    const staleManager = openMarker(marker, scope.sessionKey, dir);
    const resetManager = openMarker(marker, scope.sessionKey, dir);
    resetManager.appendResetBoundary("reset");
    expect(() => staleManager.appendMessage(buildAssistantMessage("late append"))).not.toThrow();

    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor }).kind).toBe("page");
    const events = await loadTranscriptEvents(scope);
    expect(events.map((event) => (event as { type?: unknown }).type)).toContain("reset");
    const context = JSON.stringify(openMarker(marker, scope.sessionKey, dir).buildSessionContext());
    expect(context).not.toContain("before reset");
    expect(context).toContain("late append");

    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor })).toMatchObject({
      kind: "reset",
      reason: "generation_mismatch",
    });
  });

  it("reads the latest normalized name even off the selected branch", () => {
    const manager = SessionManager.inMemory();
    expect(manager.getSessionName()).toBeUndefined();
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    manager.appendSessionInfo("old name");
    manager.appendSessionInfo("  first\nsecond\r\nthird  ");
    manager.branch(root);
    expect(manager.getSessionName()).toBe("first second third");
  });

  it("rejects persistence after the session target rebounds", async () => {
    const { dir, scope } = createScope("sqlite-prompt-release-rebound");
    const sensitivePeer = "+15551234567";
    const sessionKey = `agent:main:whatsapp:direct:${sensitivePeer}\n\x1b[31mspoof`;
    scope.sessionKey = sessionKey;
    const { sessionId, storePath } = scope;
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntryCore(scope, { sessionFile: marker, sessionId, updatedAt: 10 });
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-user",
      message: { role: "user", content: "question", timestamp: 1 },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-assistant",
      message: buildAssistantMessage("answer"),
      parentId: user.messageId,
    });
    const sessionManager = openMarker(marker, sessionKey, dir);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );

    const expectedCause = {
      actualSessionIdHash: redactIdentifier("replacement-session"),
      agentIdHash: redactIdentifier(scope.agentId),
      code: "session-rebound",
      expectedSessionIdHash: redactIdentifier(sessionId),
      sessionKeyHash: redactIdentifier(sessionKey),
    };
    const captureError = async (run: () => unknown): Promise<unknown> => {
      try {
        await run();
      } catch (error) {
        return error;
      }
      throw new Error("expected rebound transcript persistence to fail");
    };
    const compactionError = await captureError(() =>
      sessionManager.appendCompaction("late summary", assistant.messageId, 42),
    );
    expect(compactionError).toMatchObject({ cause: expectedCause });

    const entriesBeforeRejectedAppends = sessionManager.getEntries();
    const leafBeforeRejectedAppends = sessionManager.getLeafId();
    const appendParentBeforeRejectedAppends = sessionManager.getAppendParentId();
    expect(() => sessionManager.branchWithSummary(null, "late summary")).toThrow(
      "entry was not persisted",
    );
    const eventError = await captureError(() =>
      sessionManager.appendModelChange("openai", "gpt-5.5"),
    );
    const messageError = await captureError(() =>
      sessionManager.appendMessage({ role: "user", content: "late message", timestamp: 1 }),
    );
    for (const error of [eventError, messageError]) {
      expect(error).toMatchObject({ cause: expectedCause });
      const operatorFacingReason = formatErrorMessage(error);
      for (const hash of Object.values(expectedCause).filter((value) =>
        value.startsWith("sha256:"),
      )) {
        expect(operatorFacingReason).toContain(hash);
      }
      expect(operatorFacingReason).not.toContain(sessionKey);
      expect(operatorFacingReason).not.toContain(sensitivePeer);
      expect(operatorFacingReason).not.toContain("spoof");
      expect(operatorFacingReason).not.toContain(sessionId);
      expect(operatorFacingReason).not.toContain("replacement-session");
      expect(operatorFacingReason).not.toContain("\n");
      expect(operatorFacingReason).not.toContain("\x1b");
    }
    expect(sessionManager.getEntries()).toEqual(entriesBeforeRejectedAppends);
    expect(sessionManager.getLeafId()).toBe(leafBeforeRejectedAppends);
    expect(sessionManager.getAppendParentId()).toBe(appendParentBeforeRejectedAppends);
  });
});

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
