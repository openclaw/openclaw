import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  // Reconcile workers can otherwise retain the shared state lock into later tests.
  const stateDirs = [...tempDirs.dirs];
  const errors: unknown[] = [];
  for (const stateDir of stateDirs) {
    try {
      await cleanupSessionStateForTest({ stateDir });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Session fixture cleanup failed");
  }
  tempDirs.cleanup();
});

it.each(["compaction", "reset"] as const)(
  "adopts canonical boundary counts and navigation after replaying %s",
  async (kind) => {
    const dir = tempDirs.make("openclaw-bounded-rewrite-boundary-");
    const scope = {
      agentId: "main",
      sessionId: "rewrite-boundary",
      sessionKey: "agent:main:rewrite-boundary",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const full = await SessionManager.openAsync(scope, dir);
    const first = expectDefined(
      await full.appendMessageAsync({ role: "user", content: "first", timestamp: 1 }),
      "Expected appended message",
    );
    await full.appendMessageAsync({ role: "user", content: "second", timestamp: 2 });
    if (kind === "reset") {
      await full.appendResetBoundaryAsync("reset", first);
    } else {
      await full.appendCompactionAsync("summary", first, 100);
    }
    await full.appendMessageAsync({ role: "user", content: "last", timestamp: 3 });
    const manager = await SessionManager.openBoundedAsync(scope, {
      maxEvents: 10,
      maxBytes: 16384,
    });
    expect(manager.getBoundaryCount()).toBe(1);
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        { entryId: first, message: { role: "user", content: "rewritten", timestamp: 1 } },
      ],
    });
    const reopened = await SessionManager.openAsync(scope, dir);
    expect(reopened.getBoundaryCount()).toBe(1);
    expect(manager.getBoundaryCount()).toBe(reopened.getBoundaryCount());
    expect(manager.getBranch()).toEqual(reopened.getBranch());
    expect(manager.buildSessionContext()).toEqual(reopened.buildSessionContext());
  },
);

it.each(["compaction", "reset"] as const)(
  "counts a stale bounded %s append exactly once after reload",
  async (kind) => {
    const dir = tempDirs.make("openclaw-stale-boundary-count-");
    const scope = {
      agentId: "main",
      sessionId: "stale-boundary-count",
      sessionKey: "agent:main:stale-boundary-count",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const writer = await SessionManager.openAsync(scope, dir);
    const first = expectDefined(
      await writer.appendMessageAsync({ role: "user", content: "first", timestamp: 1 }),
      "Expected appended message",
    );
    const stale = await SessionManager.openBoundedAsync(scope, {
      cwd: dir,
      maxEvents: 20,
      maxBytes: 4096,
    });
    expect(stale.getBoundaryCount()).toBe(0);
    await writer.appendCustomEntryAsync("concurrent-metadata", { keep: true });
    if (kind === "compaction") {
      await stale.appendCompactionAsync("summary", first, 100);
    } else {
      await stale.appendResetBoundaryAsync("reset", first);
    }
    const reopened = await SessionManager.openBoundedAsync(scope, {
      cwd: dir,
      maxEvents: 20,
      maxBytes: 4096,
    });
    expect(reopened.getBoundaryCount()).toBe(1);
    expect(stale.getBoundaryCount()).toBe(reopened.getBoundaryCount());
    expect(stale.getBranch()).toEqual(reopened.getBranch());
    expect(stale.buildSessionContext()).toEqual(reopened.buildSessionContext());
  },
);

it("appends an assistant without parsing transcript rows outside the bounded context", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-assistant-");
  const scope = {
    agentId: "main",
    sessionId: "bounded-assistant-append",
    sessionKey: "agent:main:bounded-assistant-append",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "excluded",
    message: { role: "user", content: "excluded" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "retained",
    parentId: "excluded",
    message: { role: "user", content: "retained" },
  });
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const excluded = database.db
    .prepare("SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
    .get(scope.sessionId, "excluded");
  const excludedSeq = excluded?.seq;
  if (typeof excludedSeq !== "number") {
    throw new Error("Missing excluded transcript message");
  }
  expect(manager.getEntry("excluded")).toBeUndefined();
  const poisoned = database.db
    .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
    .run("{", scope.sessionId, excludedSeq);
  expect(poisoned.changes).toBe(1);

  const assistantId = expectDefined(
    await manager.appendMessageAsync({
      role: "assistant",
      content: [{ type: "text", text: "bounded reply" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: Date.now(),
    }),
    "Expected appended message",
  );

  expect(manager.getEntry(assistantId)).toMatchObject({ parentId: "retained" });
  const stored = database.db
    .prepare(
      "SELECT parent_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
    )
    .get(scope.sessionId, assistantId);
  expect(stored).toMatchObject({ parent_id: "retained" });
});
