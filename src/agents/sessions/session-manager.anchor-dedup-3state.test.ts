// Three-state regression for the duplicate keyed-user dedup boundary.
//
// A duplicate keyed-user delivery that hits this manager's cached current turn
// can get an `anchor === undefined` for two very different reasons, which must be
// kept apart:
//   (A) the projection index is transiently dirty (needs_rebuild=1) -- a benign
//       ~0.5-10s window after a concurrent side-append (#152511): degrade to an
//       idempotent no-op without throwing.
//   (B) the index is clean and the cached turn IS active: return its anchor.
//   (C) the index is clean but the cached turn has no active row -- another
//       manager removed/rewrote it (stale cache): must REJECT, never silently
//       false-acknowledge a non-existent turn.
//
// Also covers (D) a normal fresh append and (E) the async wrapper delegating to
// this same decision.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

function assistantMessage(text: string) {
  return { role: "assistant" as const, content: text, timestamp: 1 };
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

function userMessage(key: string, content = "hi") {
  return { role: "user" as const, content, idempotencyKey: key, timestamp: 1 };
}

async function seedSession(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  await upsertSessionEntryCore(scope, {
    sessionFile: formatSqliteSessionFileMarker(scope),
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  await appendTranscriptMessage(scope, {
    cwd: path.dirname(scope.storePath),
    eventId: "existing-assistant",
    message: assistantMessage("previous answer"),
    now: 1,
  });
}

function markIndexDirty(
  scope: { agentId: string; sessionId: string; sessionKey: string },
  dir: string,
) {
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath({
      ...scope,
      storePath: path.join(dir, "sessions.json"),
    }),
  });
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
}

describe("SessionManager anchor dedup three-state boundary", () => {
  it("A: transiently dirty index degrades duplicate keyed delivery without throwing", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-a-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-a",
      sessionKey: "agent:main:dashboard:anchor-3state-a",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-a:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);
    expect(appendedId).toBeDefined();

    markIndexDirty(scope, dir);

    const dedup = m1.appendMessageWithTranscriptAnchor(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeUndefined();
  });

  it("B: clean index duplicate returns the existing canonical anchor", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-b-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-b",
      sessionKey: "agent:main:dashboard:anchor-3state-b",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-b:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // Index is clean (no side-append); the cached turn is active, so the anchor
    // resolves to a real canonical anchor.
    const dedup = m1.appendMessageWithTranscriptAnchor(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeDefined();
    expect(dedup.anchor?.entryId).toBe(appendedId);
  });

  it("C: a stale cached turn removed by another manager is rejected, not false-acked", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-c-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-c",
      sessionKey: "agent:main:dashboard:anchor-3state-c",
      storePath: path.join(dir, "sessions.json"),
    };
    const key = "anchor-3state-c:user";
    const user = userMessage(key);
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    m1.appendMessage(user);

    // A second manager on the same session removes the trailing keyed user K.
    const m2 = SessionManager.open(scope, dir);
    const removed = m2.removeTrailingEntries(
      (entry) =>
        (entry as { message?: { idempotencyKey?: string } }).message?.idempotencyKey === key,
    );
    expect(removed).toBeGreaterThan(0);

    // m1 never reloaded; its local cache still points at the removed turn. The
    // index is clean, so the active projection has no row for the cached entry
    // -- this must reject, not return appended:false.
    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
  });

  it("D: a fresh (non-duplicate) keyed append persists with appended:true and an anchor", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-d-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-d",
      sessionKey: "agent:main:dashboard:anchor-3state-d",
      storePath: path.join(dir, "sessions.json"),
    };
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const result = m1.appendMessageWithTranscriptAnchor(userMessage("anchor-3state-d:user"));
    expect(result.appended).toBe(true);
    expect(result.anchor).toBeDefined();
    expect(result.entryId).toBeDefined();
  });

  it("E: the async user wrapper shares the dirty-index degrade (no throw)", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-e-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-e",
      sessionKey: "agent:main:dashboard:anchor-3state-e",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-e:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);
    markIndexDirty(scope, dir);

    const dedup = await m1.appendMessageWithTranscriptAnchorAsync(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeUndefined();
  });

  it("F: dirty index but cached turn removed from the durable log still rejects (no false-ack)", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-f-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-f",
      sessionKey: "agent:main:dashboard:anchor-3state-f",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-f:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // Simulate another writer that physically removes the cached turn's durable event row (a
    // suffix remove deletes transcript_events, which cascades transcript_event_identities) but
    // crashes before rebuilding the projection, leaving it dirty. Degrading on "dirty" alone
    // would false-acknowledge a turn that is no longer even in the durable tree; the canonical
    // visible-path revalidation must reject instead.
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath({ ...scope, storePath: scope.storePath }),
    });
    const kSeq = database.db
      .prepare("SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
      .get(scope.sessionId, appendedId) as { seq: number } | undefined;
    expect(kSeq).toBeTruthy();
    database.db
      .prepare("DELETE FROM transcript_events WHERE session_id = ? AND seq = ?")
      .run(scope.sessionId, kSeq!.seq);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
  });

  it("G: dirty index but cached turn displaced off the canonical active path still rejects", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-g-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-g",
      sessionKey: "agent:main:dashboard:anchor-3state-g",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-g:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // A second manager on the SAME session advances the durable tail past K (assistant A2) and
    // then writes a real leaf-control branch switch back to "existing-assistant". K's identity
    // history is NOT deleted; it is simply displaced onto a branch the canonical leaf no longer
    // selects. The leaf-control write marks the projection dirty (it never forward-indexes
    // through a branch change).
    const m2 = SessionManager.open(scope, dir);
    m2.appendMessage(buildAssistantMessage("late"));
    m2.appendLeafControl({ targetId: "existing-assistant", appendParentId: "existing-assistant" });

    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath({ ...scope, storePath: scope.storePath }),
    });
    // Non-vacuity proof: the OLD handwritten heuristic (walk the raw transcript_event_identities
    // parent chain from max seq) still reaches K -- the tail leaf-control's raw parent is A2,
    // whose parent is K -- so it would have wrongly degraded (false-ack). The new canonical
    // visible-path owner does not.
    const oldHeuristic = database.db
      .prepare(
        `WITH RECURSIVE chain AS (
           SELECT event_id, parent_id FROM (
             SELECT event_id, parent_id, seq FROM transcript_event_identities
               WHERE session_id = ? ORDER BY seq DESC LIMIT 1
           )
           UNION ALL
           SELECT i.event_id, i.parent_id FROM transcript_event_identities i
             JOIN chain c ON i.event_id = c.parent_id WHERE i.session_id = ?
         )
         SELECT COUNT(*) AS hit FROM chain WHERE event_id = ?`,
      )
      .get(scope.sessionId, scope.sessionId, appendedId) as { hit: number };
    expect(oldHeuristic.hit).toBe(1);

    // m1 never reloaded; its cache still names K as the current turn. The canonical active
    // branch now excludes K, so replaying the duplicate must reject, not degrade.
    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
  });

  it("G2: dirty index but cached user turn completed by a same-branch assistant answer still rejects", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-g2-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-g2",
      sessionKey: "agent:main:dashboard:anchor-3state-g2",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-g2:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // A second manager on the SAME branch completes K's turn with an assistant answer. K's
    // identity history is retained and K remains an ancestor on the visible path -- but K is no
    // longer the canonical current turn (the current-turn walk stops at the assistant answer).
    // Then dirty the projection the way a concurrent side-append does.
    const m2 = SessionManager.open(scope, dir);
    m2.appendMessage(buildAssistantMessage("completed answer"));
    markIndexDirty(scope, dir);

    // Non-vacuity: K is still on the visible path (it is an ancestor of the assistant answer),
    // so a visible-path-membership check would have wrongly degraded (false-acked). The canonical
    // current-turn walk resolves to the assistant answer, not K.
    expect(appendedId).toBeTruthy();

    // m1 never reloaded; its cache still names K as the current turn. K's turn has completed,
    // so replaying the duplicate must reject, not degrade.
    expect(() => m1.appendMessageWithTranscriptAnchor(user)).toThrowError(
      /Session transcript anchor was not returned/,
    );
  });

  it("G3: runtime-context metadata above the cached turn stays traversable while dirty", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-g3-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-g3",
      sessionKey: "agent:main:dashboard:anchor-3state-g3",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-g3:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    const appendedId = m1.appendMessage(user);

    // A second manager appends a runtime-context metadata row on top of K (the tail). The
    // manager's current-turn walk SKIPS this row, so K is still the canonical current turn.
    const m2 = SessionManager.open(scope, dir);
    m2.appendCustomMessageEntry(OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, "child context", false);
    markIndexDirty(scope, dir);

    // The durable current-turn walk must also skip the runtime-context row (its customType is
    // preserved in the resolver's projection) and resolve back to K, so replaying the duplicate
    // degrades (idempotent) instead of throwing as if K had completed.
    const dedup = m1.appendMessageWithTranscriptAnchor(user);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeUndefined();
  });

  it("H: duplicate delivery inside an enclosing write transaction reaches the replay", async () => {
    const dir = tempDirs.make("openclaw-anchor-3state-h-");
    const scope = {
      agentId: "main",
      sessionId: "anchor-3state-h",
      sessionKey: "agent:main:dashboard:anchor-3state-h",
      storePath: path.join(dir, "sessions.json"),
    };
    const user = userMessage("anchor-3state-h:user");
    await seedSession(scope);

    const m1 = SessionManager.open(scope, dir);
    m1.appendMessage(user);

    // Pass the fixture's agent + store path so the OUTER transaction opens the SAME database file
    // m1 reads (without it, runOpenClawAgentWriteTransaction opens the default agent db and the
    // replay never hits a nested transaction on the fixture handle).
    const fixtureDbOptions = {
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    };
    let replay: ReturnType<SessionManager["appendMessageWithTranscriptAnchor"]> | undefined;
    runOpenClawAgentWriteTransaction((database) => {
      expect(database.path).toBe(fixtureDbOptions.path);
      // The outer write tx holds the SAME pooled handle the anchor read reuses. Prove the nested
      // transaction is real: a raw BEGIN on this handle must fail precisely -- exactly what the
      // old unconditional-BEGIN anchor read would have thrown. The savepoint-aware
      // runSqliteDeferredTransactionSync instead nests via SAVEPOINT and lets the replay through.
      expect(database.db.isTransaction).toBe(true);
      expect(() => database.db.exec("BEGIN")).toThrow(
        /cannot start a transaction within a transaction/,
      );
      replay = m1.appendMessageWithTranscriptAnchor(user);
    }, fixtureDbOptions);
    expect(replay?.appended).toBe(false);
  });
});
