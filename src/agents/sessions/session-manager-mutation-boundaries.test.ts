import assert from "node:assert/strict";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage as userMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { assistantText, sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { cleanupTrackedSessionState } from "./session-state-cleanup.test-support.js";

const tempDirs = createTempDirTracker();

async function openSession(label: string) {
  const dir = tempDirs.make(`openclaw-${label}-`);
  const scope = sessionScope(path.join(dir, "sessions.json"), label);
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return { dir, scope, manager: SessionManager.open(scope, dir) };
}

function expectCanonicalView(manager: SessionManager, reopened: SessionManager) {
  expect([manager.getBoundaryCount(), reopened.getBoundaryCount()]).toEqual([1, 1]);
  expect(manager.getBranch()).toEqual(reopened.getBranch());
  expect(manager.buildSessionContext()).toEqual(reopened.buildSessionContext());
}

function appendBoundary(manager: SessionManager, kind: "compaction" | "reset", first: string) {
  return kind === "reset"
    ? manager.appendResetBoundary("reset", first)
    : manager.appendCompaction("summary", first, 100);
}

function rewriteUser(manager: SessionManager, entryId: string, text: string, timestamp = 1) {
  return rewriteTranscriptEntriesInSessionManager({
    sessionManager: manager,
    replacements: [{ entryId, message: userMessage(text, timestamp) }],
  });
}

afterEach(async () => {
  // Reconcile workers can otherwise retain the shared state lock into later tests.
  await cleanupTrackedSessionState(tempDirs.dirs, tempDirs.cleanup);
});

it("keeps deprecated sync rewrite publication ahead of synchronous commit observers", async () => {
  const { scope, manager } = await openSession("rewrite-observer");
  const first = manager.appendMessage(userMessage("first", 1));
  const tail = manager.appendMessage(userMessage("tail", 2));
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  requireNativeSqliteDatabase(database.db).function("queue_observer_append", () => {
    expect(
      deferOpenClawAgentPostCommitPublication(database, () => {
        manager.appendMessage(userMessage("observer", 3));
      }),
    ).toBe(true);
    return 0;
  });
  database.db.exec(
    "CREATE TRIGGER append_from_observer AFTER INSERT ON transcript_events WHEN json_extract(NEW.event_json, '$.message.content') = 'replacement' BEGIN SELECT queue_observer_append(); END;",
  );
  const rewrite = manager.prepareTranscriptRewrite();
  rewrite.sessionManager.resetLeaf();
  const replacement = rewrite.sessionManager.appendMessage(userMessage("replacement", 1));
  const copiedTail = rewrite.sessionManager.appendMessage(userMessage("tail", 2));
  rewrite.commit(
    new Map([
      [first, replacement],
      [tail, copiedTail],
    ]),
  );
  expect(manager.getBranch()).toMatchObject([
    { message: { content: "replacement" } },
    { message: { content: "tail" } },
    { message: { content: "observer" } },
  ]);
  expect(SessionManager.open(scope).getBranch()).toEqual(manager.getBranch());
});

it("does not certify stale navigation with a post-commit replacement version", async () => {
  const { scope, manager } = await openSession("postcommit-race");
  const first = manager.appendMessage(userMessage("first", 1));
  const second = manager.appendMessage(userMessage("second", 2));
  const control = manager.appendLeafControl({
    targetId: first,
    appendParentId: second,
    appendMode: "side",
  });
  const kept = manager.appendMessage(userMessage("kept-after-trim", 3));
  manager.appendMessage(userMessage("remove-tail", 4));
  let published = false;
  runOpenClawAgentWriteTransaction(
    (database) => {
      expect(
        deferOpenClawAgentPostCommitPublication(database, () => {
          published = true;
          const events = loadTranscriptEventsSync(scope);
          for (const event of events) {
            if (isRecord(event) && event.id === control.id) {
              event.targetId = second;
            }
          }
          replaceTranscriptEventsSync(scope, events);
        }),
      ).toBe(true);
      expect(
        manager.removeTrailingEntries(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            entry.message.content === "remove-tail",
        ),
      ).toBe(1);
    },
    { agentId: scope.agentId, path: resolveSessionTranscriptDatabasePath(scope) },
  );
  expect(published).toBe(true);
  const committed = loadTranscriptEventsSync(scope);
  const rewrite = () => rewriteUser(manager, kept, "replacement", 3);
  await expect(rewrite()).rejects.toThrow("Session transcript changed");
  expect(loadTranscriptEventsSync(scope)).toEqual(committed);
  manager.reloadPersistedTranscript();
  expect((await rewrite()).changed).toBe(true);
  expect(SessionManager.open(scope).getBranch()).toMatchObject([
    { message: { content: "first" } },
    { message: { content: "second" } },
    { message: { content: "replacement" } },
  ]);
});

it.each(["compaction", "reset"] as const)(
  "adopts canonical boundary counts and navigation after replaying %s",
  async (kind) => {
    const { dir, scope, manager: full } = await openSession("rewrite-boundary");
    const first = full.appendMessage(userMessage("first", 1));
    full.appendMessage(userMessage("second", 2));
    appendBoundary(full, kind, first);
    full.appendMessage(userMessage("last", 3));
    const manager = SessionManager.openBounded(scope, { maxEvents: 10, maxBytes: 16384 });
    expect(manager.getBoundaryCount()).toBe(1);
    await rewriteUser(manager, first, "rewritten");
    expectCanonicalView(manager, SessionManager.open(scope, dir));
  },
);

it.each(["compaction", "reset"] as const)(
  "counts a stale bounded %s append exactly once after reload",
  async (kind) => {
    const { dir, scope, manager: writer } = await openSession("stale-boundary-count");
    const first = writer.appendMessage(userMessage("first", 1));
    const stale = SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 4096 });
    expect(stale.getBoundaryCount()).toBe(0);
    writer.appendCustomEntry("concurrent-metadata", { keep: true });
    appendBoundary(stale, kind, first);
    expectCanonicalView(
      stale,
      SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 4096 }),
    );
  },
);

it("appends an assistant without parsing transcript rows outside the bounded context", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-assistant-");
  const scope = sessionScope(path.join(dir, "sessions.json"), "bounded-assistant-append");
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const event of [{ eventId: "excluded" }, { eventId: "retained", parentId: "excluded" }]) {
    await appendTranscriptMessage(scope, {
      cwd: dir,
      ...event,
      message: { role: "user", content: event.eventId },
    });
  }
  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const readIdentity = (id: string) =>
    database.db
      .prepare(
        "SELECT seq, parent_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
      )
      .get(scope.sessionId, id);
  const excludedSeq = readIdentity("excluded")?.seq;
  assert(typeof excludedSeq === "number", "Missing excluded transcript message");
  expect(manager.getEntry("excluded")).toBeUndefined();
  expect(
    database.db
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
      .run("{", scope.sessionId, excludedSeq).changes,
  ).toBe(1);
  const assistantId = manager.appendMessage(assistantText("bounded reply"));
  expect(manager.getEntry(assistantId)).toMatchObject({ parentId: "retained" });
  expect(readIdentity(assistantId)).toMatchObject({ parent_id: "retained" });
});
