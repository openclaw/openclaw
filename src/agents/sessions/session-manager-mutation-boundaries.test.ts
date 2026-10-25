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
  const options = { agentId: scope.agentId, path: resolveSessionTranscriptDatabasePath(scope) };
  return {
    dir,
    scope,
    options,
    manager: SessionManager.open(scope, dir),
    database: openOpenClawAgentDatabase(options),
  };
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
  const { scope, manager, database } = await openSession("rewrite-observer");
  const first = manager.appendMessage(userMessage("first", 1));
  const tail = manager.appendMessage(userMessage("tail", 2));
  requireNativeSqliteDatabase(database.db).function("queue_observer_append", () => {
    deferOpenClawAgentPostCommitPublication(database, () => {
      manager.appendMessage(userMessage("observer", 3));
    });
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
  const { scope, manager, options } = await openSession("postcommit-race");
  const first = manager.appendMessage(userMessage("first", 1));
  const second = manager.appendMessage(userMessage("second", 2));
  const control = manager.appendLeafControl({
    targetId: first,
    appendParentId: second,
    appendMode: "side",
  });
  const kept = manager.appendMessage(userMessage("kept-after-trim", 3));
  const tail = manager.appendMessage(userMessage("remove-tail", 4));
  runOpenClawAgentWriteTransaction((database) => {
    deferOpenClawAgentPostCommitPublication(database, () => {
      const events = loadTranscriptEventsSync(scope);
      for (const event of events) {
        if (isRecord(event) && event.id === control.id) {
          event.targetId = second;
        }
      }
      replaceTranscriptEventsSync(scope, events);
    });
    expect(manager.removeTrailingEntries((entry) => entry.id === tail)).toBe(1);
  }, options);
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

it.each([
  ["compaction", "replay"],
  ["reset", "replay"],
  ["compaction", "stale append"],
  ["reset", "stale append"],
] as const)(
  "adopts canonical %s boundary counts and navigation after %s",
  async (kind, operation) => {
    const { dir, scope, manager: writer } = await openSession("stale-boundary-count");
    const first = writer.appendMessage(userMessage("first", 1));
    if (operation === "replay") {
      writer.appendMessage(userMessage("second", 2));
      appendBoundary(writer, kind, first);
      writer.appendMessage(userMessage("last", 3));
    }
    const limits = { cwd: dir, maxEvents: 20, maxBytes: 16384 };
    const manager = SessionManager.openBounded(scope, limits);
    expect(manager.getBoundaryCount()).toBe(operation === "replay" ? 1 : 0);
    if (operation === "replay") {
      await rewriteUser(manager, first, "rewritten");
    } else {
      writer.appendCustomEntry("concurrent-metadata", { keep: true });
      appendBoundary(manager, kind, first);
    }
    expectCanonicalView(manager, SessionManager.open(scope, dir));
    expectCanonicalView(manager, SessionManager.openBounded(scope, limits));
  },
);

it("appends an assistant without parsing transcript rows outside the bounded context", async () => {
  const { dir, scope, database } = await openSession("bounded-assistant-append");
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
