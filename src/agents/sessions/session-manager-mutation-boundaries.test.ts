import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import {
  makeAgentAssistantMessage,
  makeAgentToolResultMessage,
} from "../test-helpers/agent-message-fixtures.js";
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

function makePreparedActivity(parentId: string | null) {
  return createNestedToolActivity({
    runId: "prepared-run",
    scopeId: "prepared-scope",
    afterEntryId: parentId,
    startOrder: 0,
    parentToolCallId: "outer-call",
    toolCallId: "nested-call",
    toolName: "send",
    input: { text: "delivered" },
    result: { content: [{ type: "text", text: "sent" }] },
    isError: false,
    startedAt: 2,
    timestamp: 3,
  });
}

async function prepareActivityFixture(bounded = false) {
  const dir = tempDirs.make("openclaw-prepared-activity-");
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
    sessionId: "prepared-activity",
    sessionKey: "agent:main:prepared-activity",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const writer = SessionManager.open(scope, dir);
  const admission = writer.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current turn",
    timestamp: 1,
  });
  assert(admission.anchor, "Missing prepared activity admission");
  const reopen = () =>
    bounded
      ? SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 16_384 })
      : SessionManager.open(scope, dir);
  const manager = bounded ? reopen() : writer;
  const guard = installSessionToolResultGuard(manager);
  const parentId = manager.appendMessage(
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "outer-call", name: "exec", arguments: { code: "source" } },
      ],
      stopReason: "toolUse",
    }),
  );
  return {
    scope,
    manager,
    reopen,
    guard,
    admission: { ...admission, anchor: admission.anchor },
    parentId,
    activity: makePreparedActivity(parentId),
  };
}

it.each([false, true])(
  "persists a prepared activity after a real delivery mirror (bounded=%s)",
  async (bounded) => {
    const { scope, manager, reopen, guard, admission, parentId, activity } =
      await prepareActivityFixture(bounded);
    const before = loadTranscriptEventsSync(scope);
    const resultMessage = makeAgentToolResultMessage({
      toolCallId: "outer-call",
      toolName: "exec",
      content: [{ type: "text", text: "completed" }],
      isError: false,
    });
    const {
      mirrorId,
      activityId: storedActivityId,
      resultId: storedResultId,
    } = await runWithSessionTranscriptReadFence(
      { ...admission.anchor, logicalTurnId: "current", role: "user" },
      async () => {
        const mirrored = await appendAssistantMessageToSessionTranscript({
          ...scope,
          expectedSessionId: scope.sessionId,
          text: "delivered",
          idempotencyKey: "delivery-once",
        });
        expect(mirrored.ok).toBe(true);
        if (!mirrored.ok) {
          throw new Error(mirrored.reason);
        }
        expect(manager.getAppendParentId()).toBe(parentId);
        const activityId = manager.appendMessage(activity, { preparedTurnParentId: parentId });
        expect(manager.getAppendParentId()).toBe(activityId);
        expect(manager.getLeafId()).toBe(bounded ? mirrored.messageId : activityId);
        expect(guard.getPendingIds()).toEqual(["outer-call"]);
        if (bounded) {
          expect(manager.getEntry(activityId)).toBeUndefined();
        }
        const resultId = manager.appendMessage(resultMessage);
        expect(manager.getAppendParentId()).toBe(resultId);
        expect(manager.getLeafId()).toBe(resultId);
        expect(guard.getPendingIds()).toEqual([]);
        guard.flushPendingToolResults();
        expect(guard.getPendingIds()).toEqual([]);
        expect(manager.getBranch().map((entry) => entry.id)).toEqual([
          admission.entryId,
          parentId,
          mirrored.messageId,
          ...(bounded ? [] : [activityId]),
          resultId,
        ]);
        if (bounded) {
          expect(manager.getEntry(activityId)).toBeUndefined();
        } else {
          expect(manager.getEntry(activityId)).toMatchObject({
            parentId: mirrored.messageId,
            message: activity,
          });
        }
        expect(
          manager.buildSessionContext().messages.some((message) => message.role === "custom"),
        ).toBe(false);
        return { mirrorId: mirrored.messageId, activityId, resultId };
      },
    );
    // Raw/full reads run outside the admission fence; the tested bounded view stays bounded.
    const stored = loadTranscriptEventsSync(scope);
    expect(stored.slice(0, before.length)).toEqual(before);
    expect(stored).toHaveLength(before.length + 3);
    const messages = stored.filter(isRecord).filter((entry) => entry.type === "message");
    const chain = [
      { id: admission.entryId, parentId: null },
      { id: parentId, parentId: admission.entryId },
      { id: mirrorId, parentId },
      { id: storedActivityId, parentId: mirrorId },
      { id: storedResultId, parentId: storedActivityId },
    ];
    expect(
      messages.map(({ id, parentId: entryParentId }) => ({ id, parentId: entryParentId })),
    ).toEqual(chain);
    expect(messages[3]).toMatchObject({ message: activity });
    expect(messages[4]).toMatchObject({ message: resultMessage });
    const full = SessionManager.open(scope);
    expect(
      full.getBranch().map(({ id, parentId: entryParentId }) => ({ id, parentId: entryParentId })),
    ).toEqual(chain);
    expect(full.getEntry(storedActivityId)).toMatchObject({
      parentId: mirrorId,
      message: activity,
    });
    expect(full.getEntry(storedResultId)).toMatchObject({
      parentId: storedActivityId,
      message: resultMessage,
    });
    const reopened = reopen();
    expect(reopened.getBranch()).toEqual(manager.getBranch());
    expect(reopened.getAppendParentId()).toBe(storedResultId);
    expect(reopened.getLeafId()).toBe(storedResultId);
    if (bounded) {
      expect(reopened.getEntry(storedActivityId)).toBeUndefined();
    }
    expect(reopened.buildSessionContext()).toEqual(manager.buildSessionContext());
    expect(full.buildSessionContext()).toEqual(manager.buildSessionContext());
  },
);

it.each([
  "ordinary-custom",
  "other-writer-user",
  "same-manager-user",
  "new-admission",
  "off-branch-user",
  "unrelated-branch",
  "deliberate",
  "side",
  "null-parent",
] as const)("rejects prepared activity boundary drift: %s", async (change) => {
  const { scope, manager, admission, parentId, activity } = await prepareActivityFixture();
  const other = SessionManager.open(scope);
  let nextAdmissionAnchor = admission.anchor;
  if (change === "ordinary-custom") {
    other.appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: "mirror" }] }));
  } else if (change === "other-writer-user") {
    other.appendMessage({ role: "user", content: "new turn", timestamp: 4 });
  } else if (change === "same-manager-user" || change === "new-admission") {
    const nextAdmission = manager.appendMessageWithTranscriptAnchor({
      role: "user",
      content: "new turn",
      timestamp: 4,
    });
    assert(nextAdmission.anchor, "Missing next user admission");
    nextAdmissionAnchor = nextAdmission.anchor;
  } else if (change === "off-branch-user") {
    other.branch(admission.entryId);
    other.appendMessage({ role: "user", content: "side turn", timestamp: 4 });
    other.appendLeafControl({ targetId: parentId, appendParentId: parentId });
    expect(SessionManager.open(scope).getAppendParentId()).toBe(parentId);
  } else if (change === "unrelated-branch") {
    other.branch(admission.entryId);
    other.appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: "branch" }] }));
  } else if (change === "deliberate") {
    manager.branch(parentId);
  } else if (change === "side") {
    manager.appendLeafControl({ targetId: parentId, appendParentId: parentId, appendMode: "side" });
  }
  const before = loadTranscriptEventsSync(scope);
  const branchBefore = manager.getBranch();
  const append = () =>
    manager.appendMessage(
      activity,
      change === "ordinary-custom"
        ? undefined
        : { preparedTurnParentId: change === "null-parent" ? null : parentId },
    );
  const expectRejected = () =>
    expect(append).toThrow("SQLite transcript changed while preparing rewrite");
  if (change === "new-admission") {
    runWithSessionTranscriptReadFence(
      { ...nextAdmissionAnchor, logicalTurnId: "next", role: "user" },
      expectRejected,
    );
  } else {
    expectRejected();
  }
  expect(loadTranscriptEventsSync(scope)).toEqual(before);
  expect(manager.getBranch()).toEqual(branchBefore);
});

it("does not adopt a newer user during a prepared activity retry", async () => {
  const { scope, manager, parentId, activity } = await prepareActivityFixture();
  const other = SessionManager.open(scope);
  const persist = manager.persist.bind(manager);
  const spy = vi.spyOn(manager, "persist").mockImplementationOnce((entry, options) => {
    other.appendMessage({ role: "user", content: "racing turn", timestamp: 4 });
    return persist(entry, options);
  });
  try {
    expect(() => manager.appendMessage(activity, { preparedTurnParentId: parentId })).toThrow(
      "SQLite transcript changed while preparing rewrite",
    );
    expect(manager.getAppendParentId()).toBe(parentId);
    expect(
      loadTranscriptEventsSync(scope).some(
        (entry) =>
          isRecord(entry) &&
          entry.type === "message" &&
          isRecord(entry.message) &&
          entry.message.role === "custom",
      ),
    ).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it("rejects prepared user replay before its idempotency shortcut", async () => {
  const { manager } = await prepareActivityFixture();
  const message = { role: "user" as const, content: "next", timestamp: 4, idempotencyKey: "next" };
  const parentId = manager.appendMessage(message);
  expect(() => manager.appendMessage(message, { preparedTurnParentId: parentId })).toThrow(
    "Prepared turn appends require a persisted non-user message",
  );
});

it("accepts an explicitly captured empty root in a persistent manager", async () => {
  const dir = tempDirs.make("openclaw-prepared-root-");
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
    sessionId: "prepared-root",
    sessionKey: "agent:main:prepared-root",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, dir);
  const entryId = manager.appendMessage(makePreparedActivity(null), { preparedTurnParentId: null });
  expect(manager.getEntry(entryId)?.parentId).toBeNull();
  expect(SessionManager.open(scope).getBranch()).toEqual(manager.getBranch());
});

it("keeps ordinary detached activities chained and rejects explicit preparation", () => {
  const manager = SessionManager.inMemory();
  const parentId = manager.appendMessage({ role: "user", content: "detached", timestamp: 1 });
  const activity = makePreparedActivity(parentId);
  const first = manager.appendMessage(activity);
  const second = manager.appendMessage({ ...activity, timestamp: 4 });
  expect(manager.getEntry(first)?.parentId).toBe(parentId);
  expect(manager.getEntry(second)?.parentId).toBe(first);
  expect(() => manager.appendMessage(activity, { preparedTurnParentId: null })).toThrow(
    "Prepared turn appends require a persisted non-user message",
  );
  expect(manager.getAppendParentId()).toBe(second);
});

it("publishes the rewritten view before commit observers append", async () => {
  const dir = tempDirs.make("openclaw-rewrite-observer-");
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
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
    env: scope.env,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  expect(database.ownerEnv.OPENCLAW_STATE_DIR).toBe(dir);
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
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
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
    env: scope.env,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  expect(database.ownerEnv.OPENCLAW_STATE_DIR).toBe(dir);
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
      env: { ...process.env, OPENCLAW_STATE_DIR: dir },
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
      env: { ...process.env, OPENCLAW_STATE_DIR: dir },
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
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
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
    env: scope.env,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  expect(database.ownerEnv.OPENCLAW_STATE_DIR).toBe(dir);
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
