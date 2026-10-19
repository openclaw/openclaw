import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
afterEach(() => vi.restoreAllMocks());

function createScope(sessionId: string, sessionKey = `agent:main:${sessionId}`) {
  const dir = tempDirs.make("openclaw-session-manager-");
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(dir, "sessions.json"),
  };
  return { dir, scope };
}

async function expectTranscript(
  scope: Parameters<typeof loadTranscriptEvents>[0],
  header: string | { id: string; parentSession: string },
  ...messageIds: string[]
) {
  expect(await loadTranscriptEvents(scope)).toEqual([
    expect.objectContaining({
      type: "session",
      ...(typeof header === "string" ? { id: header } : header),
    }),
    ...messageIds.map((id) => expect.objectContaining({ id, type: "message" })),
  ]);
}

async function branchSource(
  sessionId: string,
  entry: Partial<Parameters<typeof upsertSessionEntryCore>[1]>,
) {
  const { dir, scope } = createScope(sessionId, `agent:main:dashboard:${sessionId}`);
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 10,
    sessionFile: formatSqliteSessionFileMarker(scope),
    ...entry,
  });
  const user = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "user",
    message: { role: "user", content: "question" },
  });
  const assistant = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "reply",
    parentId: user.messageId,
    message: textAssistant("answer"),
  });
  return {
    scope,
    userId: user.messageId,
    replyId: assistant.messageId,
    manager: SessionManager.open(scope, dir),
  };
}

function managerState(manager: SessionManager) {
  return {
    entries: manager.getEntries(),
    sessionId: manager.getSessionId(),
    target: manager.getSessionTarget(),
    leafId: manager.getLeafId(),
    appendParentId: manager.getAppendParentId(),
  };
}

function message(id: string, parentId: string | null, content: string) {
  return { type: "message", id, parentId, message: { role: "user", content } };
}

it.each(["memory", "sqlite"].flatMap((mode) => [3, 4].map((version) => ({ mode, version }))))(
  "preserves projection version $version, opaque parents, and labels in a $mode branch",
  async ({ mode, version }) => {
    const { dir, scope } = createScope("source-session", "agent:main:branch-labels");
    const entries = [
      { type: "session", version, id: scope.sessionId, cwd: dir },
      message("user", null, "question"),
      { type: "future-metadata", id: "opaque", parentId: "user", details: { value: "retained" } },
      message("reply", "opaque", "reply"),
      {
        type: "label",
        id: "label",
        parentId: "reply",
        targetId: "user",
        label: "named",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      message("abandoned", "label", "excluded"),
    ];
    if (mode === "sqlite") {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      replaceTranscriptEventsSync(scope, entries);
    }
    const manager =
      mode === "sqlite" ? SessionManager.open(scope, dir) : SessionManager.fromEntries(entries);

    const branchId = await manager.createBranchedSession("reply");
    const expected = [
      expect.objectContaining({ id: manager.getSessionId(), type: "session", version }),
      ...entries.slice(1, 4),
      expect.objectContaining({ ...entries[4], id: expect.any(String) }),
    ];
    expect(manager.getSessionId()).not.toBe(scope.sessionId);
    expect(manager.getPersistedEntries()).toEqual(expected);
    expect(manager.getLabel("user")).toBe("named");
    expect(manager.getEntry("abandoned")).toBeUndefined();
    if (mode === "sqlite") {
      expect(branchId).toBe(manager.getSessionId());
      expect(await loadTranscriptEvents(scope)).toEqual(entries);
      expect(SessionManager.open({ ...scope, sessionId: branchId! }).getPersistedEntries()).toEqual(
        expected,
      );
    } else {
      expect(branchId).toBeUndefined();
      expect(manager.getSessionTarget()).toBeUndefined();
    }
    manager.appendCompaction("summary", "user", 1);
    manager.appendResetBoundary("reset", "reply");
    const reopened =
      mode === "sqlite"
        ? SessionManager.openBounded(
            { ...scope, sessionId: manager.getSessionId() },
            { maxBytes: 4096, maxEvents: 2 },
          )
        : SessionManager.fromEntries(manager.getPersistedEntries());
    expect(reopened.getHeader()?.version).toBe(version);
  },
);

it("creates SQLite-backed branch sessions without rewriting the source transcript", async () => {
  const { scope, userId, replyId, manager } = await branchSource("branch-source", {
    delivery: { kind: "internal" },
  });
  const { sessionId, sessionKey } = scope;
  const sourceTarget = manager.getSessionTarget();
  expect(sourceTarget).toMatchObject(scope);
  const observedBranches: unknown[] = [];
  const stop = onSessionIdentityMutation((mutation) => {
    if (mutation.kind !== "replace" || !mutation.current.sessionKeys.includes(sessionKey)) {
      return;
    }
    observedBranches.push({
      sessionId: manager.getSessionId(),
      target: manager.getSessionTarget(),
      durableEntries: SessionManager.open({
        ...scope,
        sessionId: mutation.current.sessionId!,
      }).getEntries(),
    });
  });
  const branchedMarker = await manager.createBranchedSession(replyId).finally(stop);
  const branchedSessionId = manager.getSessionId();

  expect(branchedMarker).toBe(branchedSessionId);
  expect(branchedSessionId).not.toBe(sessionId);
  expect(observedBranches).toEqual([
    {
      sessionId: branchedSessionId,
      target: { ...sourceTarget, sessionId: branchedSessionId },
      durableEntries: manager.getEntries(),
    },
  ]);
  expect(loadSessionEntry(scope)).toMatchObject({
    delivery: { kind: "internal" },
    sessionId: branchedSessionId,
  });
  await expectTranscript(scope, sessionId, userId, replyId);
  await expectTranscript(
    { ...scope, sessionId: branchedSessionId },
    { id: branchedSessionId, parentSession: sessionId },
    userId,
    replyId,
  );
  expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
  expect(manager.removeTrailingEntries((entry) => entry.id === replyId)).toBe(1);
  expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
  await expectTranscript({ ...scope, sessionId: branchedSessionId }, branchedSessionId, userId);
});

it("does not publish a branch identity when transcript persistence fails", async () => {
  const { dir, scope } = createScope("branch-write-failure");
  const manager = SessionManager.open(scope, dir);
  const leafId = manager.appendMessage({ role: "user", content: "source", timestamp: 1 });
  const beforeEntry = loadSessionEntry(scope);
  const beforeEvents = await loadTranscriptEvents(scope);
  const before = managerState(manager);
  expect(before.target).toMatchObject(scope);
  const admission = probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      throw new Error("branch transcript write failed");
    }
    admit(request, grant);
  });
  const replacements: unknown[] = [];
  const stop = onSessionIdentityMutation((mutation) => {
    if (mutation.previous.sessionKeys.includes(scope.sessionKey)) {
      replacements.push(mutation);
    }
  });
  try {
    await expect(manager.createBranchedSession(leafId)).rejects.toThrow(
      "branch transcript write failed",
    );
  } finally {
    stop();
    admission.mockRestore();
  }

  expect(loadSessionEntry(scope)).toEqual(beforeEntry);
  expect(await loadTranscriptEvents(scope)).toEqual(beforeEvents);
  expect(managerState(manager)).toEqual({ ...before, sessionId: scope.sessionId, leafId });
  expect(replacements).toEqual([]);
});

it.each(["lifecycle", "writer", "metadata", "guarded-target", "successor-writer"])(
  "revalidates queued %s changes before branching",
  async (change) => {
    const { scope, userId, replyId, manager } = await branchSource("branch-race", {
      activeWriterRunId: "original-writer",
      lifecycleRevision: "original-revision",
    });
    const { sessionId, sessionKey } = scope;
    const branchAsWriter = () =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: {
            ...scope,
            expectedLifecycleRevision: "original-revision",
            expectedWriterRunId: "original-writer",
          },
          ...(change === "guarded-target" ? { assertCommitAllowed: () => {} } : {}),
          withTranscriptWrite: async (operation) => await operation(),
        },
        () => manager.createBranchedSession(replyId),
      );
    if (change === "successor-writer") {
      await branchAsWriter();
    }
    const branchSourceId = manager.getSessionId();
    const beforeBranch = managerState(manager);
    const writerChanged = change === "writer" || change === "successor-writer";
    const ownerChangeGate = createDeferredCore();
    const ownerChangeStarted = createDeferredCore();
    const ownerChange = updateSessionEntry(scope, async () => {
      ownerChangeStarted.resolve();
      await ownerChangeGate.promise;
      return change === "lifecycle"
        ? { lifecycleRevision: "new-revision" }
        : writerChanged
          ? { activeWriterRunId: "new-writer" }
          : { label: "updated" };
    });
    await ownerChangeStarted.promise;

    const queuedAt = Date.now() - 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(queuedAt);
    const branch = branchAsWriter();
    await setImmediate();
    const whileQueued = managerState(manager);
    clock.mockRestore();
    const commitStartedAt = Date.now();
    ownerChangeGate.resolve();

    await ownerChange;
    if (change === "lifecycle") {
      await expect(branch).rejects.toMatchObject({
        cause: {
          code: "session-rebound",
          expectedSessionIdHash: redactIdentifier(sessionId),
          sessionKeyHash: redactIdentifier(sessionKey),
        },
      });
      expect(manager.getSessionId()).toBe(sessionId);
    } else if (writerChanged || change === "guarded-target") {
      await expect(branch).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      if (change === "successor-writer") {
        expect(() =>
          manager.appendMessage({
            role: "user",
            content: "stale successor append",
            timestamp: commitStartedAt,
          }),
        ).toThrow(SessionTranscriptWriterClaimReboundError);
      }
      expect(managerState(manager)).toEqual(beforeBranch);
    } else {
      const branchId = await branch;
      const updatedAt = loadSessionEntry(scope)?.updatedAt;
      expect(updatedAt).toBeGreaterThanOrEqual(commitStartedAt);
      expect(updatedAt).toBeLessThanOrEqual(Date.now());
      expect(manager.getSessionId()).toBe(branchId);
    }
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: change === "metadata" ? manager.getSessionId() : branchSourceId,
      lifecycleRevision: change === "lifecycle" ? "new-revision" : "original-revision",
      activeWriterRunId: writerChanged ? "new-writer" : "original-writer",
      ...(change === "metadata" ? { label: "updated" } : {}),
    });
    expect(whileQueued).toEqual(beforeBranch);
    await expectTranscript(scope, sessionId, userId, replyId);
  },
);
