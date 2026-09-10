import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("publishes the rewritten view before commit observers append", async () => {
  const dir = tempDirs.make("openclaw-rewrite-observer-");
  const scope = {
    agentId: "main",
    sessionId: "rewrite-observer",
    sessionKey: "agent:main:rewrite-observer",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  database.db.function("queue_observer_append", () => {
    expect(
      deferOpenClawAgentPostCommitPublication(database, () => {
        manager.appendMessage({ role: "user", content: "observer", timestamp: 3 });
      }),
    ).toBe(true);
    return 0;
  });
  database.db.exec(
    "CREATE TRIGGER append_from_observer AFTER INSERT ON transcript_events WHEN json_extract(NEW.event_json, '$.message.content') = 'replacement' BEGIN SELECT queue_observer_append(); END;",
  );
  rewriteTranscriptEntriesInSessionManager({
    sessionManager: manager,
    replacements: [
      { entryId: first, message: { role: "user", content: "replacement", timestamp: 1 } },
    ],
  });
  const expected = [
    { message: { content: "replacement" } },
    { message: { content: "tail" } },
    { message: { content: "observer" } },
  ];
  expect(manager.getBranch()).toMatchObject(expected);
  expect(SessionManager.open(scope).getBranch()).toEqual(manager.getBranch());
});

it("does not certify stale navigation with a post-commit replacement version", async () => {
  const dir = tempDirs.make("openclaw-postcommit-rewrite-race-");
  const scope = {
    agentId: "main",
    sessionId: "postcommit-race",
    sessionKey: "agent:main:postcommit-race",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
  const control = manager.appendLeafControl({
    targetId: first,
    appendParentId: second,
    appendMode: "side",
  });
  const kept = manager.appendMessage({ role: "user", content: "kept-after-trim", timestamp: 3 });
  manager.appendMessage({ role: "user", content: "remove-tail", timestamp: 4 });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  let queued = false;
  database.db.function("queue_navigation_replacement", () => {
    if (!queued) {
      queued = true;
      expect(
        deferOpenClawAgentPostCommitPublication(database, () => {
          const events = loadTranscriptEventsSync(scope);
          for (const event of events) {
            if (isRecord(event) && event.id === control.id) {
              event.targetId = second;
            }
          }
          replaceTranscriptEventsSync(scope, events);
        }),
      ).toBe(true);
    }
    return 0;
  });
  database.db.exec(
    // Suffix cleanup leaves the retained prefix untouched; inject at its actual deletion edge.
    "CREATE TRIGGER replace_after_commit AFTER DELETE ON transcript_events WHEN json_extract(OLD.event_json, '$.message.content') = 'remove-tail' BEGIN SELECT queue_navigation_replacement(); END;",
  );
  expect(
    manager.removeTrailingEntries(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "remove-tail",
    ),
  ).toBe(1);
  expect(queued).toBe(true);
  const committed = loadTranscriptEventsSync(scope);
  const rewrite = () =>
    rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        { entryId: kept, message: { role: "user", content: "replacement", timestamp: 3 } },
      ],
    });
  expect(rewrite).toThrow("Session transcript changed");
  expect(loadTranscriptEventsSync(scope)).toEqual(committed);
  manager.reloadPersistedTranscript();
  expect(rewrite().changed).toBe(true);
  expect(SessionManager.open(scope).getBranch()).toMatchObject([
    { message: { content: "first" } },
    { message: { content: "second" } },
    { message: { content: "replacement" } },
  ]);
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
    const full = SessionManager.open(scope, dir);
    const first = full.appendMessage({ role: "user", content: "first", timestamp: 1 });
    full.appendMessage({ role: "user", content: "second", timestamp: 2 });
    if (kind === "reset") {
      full.appendResetBoundary("reset", first);
    } else {
      full.appendCompaction("summary", first, 100);
    }
    full.appendMessage({ role: "user", content: "last", timestamp: 3 });
    const manager = SessionManager.openBounded(scope, { maxEvents: 10, maxBytes: 16384 });
    expect(manager.getBoundaryCount()).toBe(1);
    rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        { entryId: first, message: { role: "user", content: "rewritten", timestamp: 1 } },
      ],
    });
    const reopened = SessionManager.open(scope, dir);
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
    const writer = SessionManager.open(scope, dir);
    const first = writer.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const stale = SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 4096 });
    expect(stale.getBoundaryCount()).toBe(0);
    writer.appendCustomEntry("concurrent-metadata", { keep: true });
    if (kind === "compaction") {
      stale.appendCompaction("summary", first, 100);
    } else {
      stale.appendResetBoundary("reset", first);
    }
    const reopened = SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 4096 });
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
  const manager = SessionManager.openBounded(scope, {
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

  const assistantId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "bounded reply" }],
    api: "messages",
    provider: "anthropic",
    model: "sonnet-4.6",
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: Date.now(),
  });

  expect(manager.getEntry(assistantId)).toMatchObject({ parentId: "retained" });
  const stored = database.db
    .prepare(
      "SELECT parent_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
    )
    .get(scope.sessionId, assistantId);
  expect(stored).toMatchObject({ parent_id: "retained" });
});
