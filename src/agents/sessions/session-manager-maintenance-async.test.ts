import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage as userMessage } from "../../../test/helpers/user-message.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../../config/sessions/session-message-rewrite.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "../../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { customData, opaqueEntry, sessionScope } from "./session-manager-fixtures.test-support.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

async function openSession(lifecycleRevision?: string) {
  const scope = {
    ...sessionScope(
      path.join(tempDirs.make("session-maintenance-"), "sessions.json"),
      "maintenance",
    ),
    ...(lifecycleRevision ? { expectedLifecycleRevision: lifecycleRevision } : {}),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    lifecycleRevision,
  });
  return { scope, manager: await SessionManager.openAsync(scope) };
}

async function appendUser(manager: SessionManager, text: string): Promise<string> {
  return (await manager.appendMessageWithTranscriptAnchorAsync(userMessage(text, 1))).entryId;
}

async function prepareUserRewrite(manager: SessionManager, text = "replacement") {
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(rewrite.sessionManager, text);
  return { ...rewrite, replacementId };
}

function afterWorkerCommand(type: string, after: () => void | Promise<void>) {
  const original = metadataRuntime.withSessionMetadataWorker;
  const intercept: typeof original = (options, database, assertCurrent, operation, controls) =>
    original(
      options,
      database,
      assertCurrent,
      (worker) =>
        operation({
          execute: async (command, commandOptions) => {
            const result = await worker.execute(command, commandOptions);
            if (command.type === type) {
              await after();
            }
            return result;
          },
        }),
      controls,
    );
  return vi.spyOn(metadataRuntime, "withSessionMetadataWorker").mockImplementation(intercept);
}

it("shares admitted immutable payloads and opaque aliases when preparing and publishing a rewrite", async () => {
  const manager = SessionManager.fromEntries([
    { type: "session", version: 4, id: "aliases", cwd: "/synthetic" },
    { type: "opaque", id: "opaque", parentId: null },
  ]);
  const id = await manager.appendCustomEntryAsync("large-tool-output", {
    chunks: Array.from({ length: 1024 }, () => ({ text: "x".repeat(1024) })),
    child: { text: "original" },
  });
  const data = customData(manager, id);
  opaqueEntry(manager).alias = data.child;
  const original = manager.getEntry(id);
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  expect(rewrite.sessionManager.getEntry(id)).not.toBe(original);
  expect(customData(rewrite.sessionManager, id)).toBe(data);
  expect(opaqueEntry(rewrite.sessionManager).alias).toBe(data.child);
  expect(Object.isFrozen(data)).toBe(true);
  expect(Reflect.set(data, "chunks", [])).toBe(false);
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
  expect(manager.getEntry(replacementId)).toBeUndefined();
  await rewrite.commit(new Map());
  expect(customData(manager, id)).toBe(data);
  expect(manager.getEntry(replacementId)).toMatchObject({
    appendMode: "side",
    message: { content: "replacement" },
  });
  await appendUser(rewrite.sessionManager, "later");
  expect(manager.getBranch()).toHaveLength(2);
});

it.each([false, true])("isolates rewrite payloads with opaque SDK data: %s", async (opaque) => {
  const shared = { text: "original" };
  const buffer = new ArrayBuffer(3);
  const manager = SessionManager.fromEntries([
    { type: "session", version: 4, id: "snapshot", cwd: "/synthetic" },
    { type: "custom", id: "data", parentId: null, customType: "fixture", data: shared },
    {
      type: "opaque",
      id: "opaque",
      shared,
      ...(opaque ? { buffer, bytes: new Uint8Array(buffer) } : {}),
    },
  ]);
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  const entry = rewrite.sessionManager.getEntry("data");
  const data = customData(rewrite.sessionManager, "data");
  const record = opaqueEntry(rewrite.sessionManager);
  expect(record.shared).toBe(data);
  if (opaque) {
    assert(record.bytes instanceof Uint8Array, "Missing opaque bytes");
    expect(record.bytes.buffer).toBe(record.buffer);
    expect(record.buffer).not.toBe(buffer);
  }
  data.text = "prepared";
  expect(manager.getEntry("data")).toMatchObject({ data: { text: "original" } });
  await rewrite.commit(new Map());
  const committed = manager.getEntry("data");
  expect(committed).toMatchObject({ data: { text: "prepared" } });
  expect(committed).not.toBe(entry);
  data.text = "later";
  expect(committed).toMatchObject({ data: { text: "prepared" } });
});

it("settles queued suffix removals in order and rebuilds the pending branch projection", async () => {
  const { scope, manager } = await openSession();
  const retained = await appendUser(manager, "keep");
  const removed = await manager.appendCustomEntryAsync("temporary", { bytes: "exact" });
  runOpenClawAgentWriteTransaction(
    (database) => markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId),
    { agentId: scope.agentId, path: resolveSessionTranscriptDatabasePath(scope) },
  );
  vi.spyOn(manager, "removeTrailingEntries").mockImplementation(() => {
    throw new Error("sync compatibility adapter used");
  });
  const first = manager.removeTrailingEntriesAsync((entry) => entry.id === removed);
  const second = manager.removeTrailingEntriesAsync((entry) => entry.id === removed);
  expect(await Promise.all([first, second])).toEqual([1, 0]);
  expect(manager.getLeafId()).toBe(retained);
  await waitForSessionTranscriptProjection(scope);
  expect(
    SessionManager.openBounded(scope, { maxEvents: 10, maxBytes: 64_000 }).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getBranch()).toEqual(manager.getBranch());
  expect(reopened.getLeafId()).toBe(retained);
});

it.each(["read", "receipt"] as const)(
  "fences navigation changes during suffix %s waits",
  async (boundary) => {
    const { scope, manager } = await openSession();
    const seed = await appendUser(manager, "keep");
    const removed = await manager.appendCustomEntryAsync("temporary");
    await manager.appendLeafControlAsync({
      targetId: removed,
      appendParentId: seed,
      appendMode: "side",
    });
    const before = await loadTranscriptEvents(scope);
    const prepareHydration = transcriptHydration.prepareSessionTranscriptHydration;
    const interception =
      boundary === "read"
        ? vi
            .spyOn(transcriptHydration, "prepareSessionTranscriptHydration")
            .mockImplementation((...args) => {
              const prepared = prepareHydration(...args);
              return {
                ...prepared,
                readMaintenance: async (request) => {
                  const facts = await prepared.readMaintenance(request);
                  manager.branch(seed);
                  return facts;
                },
              };
            })
        : afterWorkerCommand("session.transcript.replaceSuffix", () => manager.resetLeaf());
    const failure = await withRestoredMocks([interception], () =>
      manager
        .removeTrailingEntriesAsync((entry) => entry.id === removed)
        .catch((error: unknown) => error),
    );
    if (boundary === "read") {
      expect(failure).toMatchObject({
        message: "Session transcript navigation changed before publication",
      });
      expect(manager.getLeafId()).toBe(seed);
      expect(manager.getAppendParentId()).toBe(seed);
      expect(manager.getAppendMode()).toBeUndefined();
      expect(await loadTranscriptEvents(scope)).toEqual(before);
      const next = await manager.appendCustomEntryAsync("after-navigation-race");
      expect(manager.getEntry(next)?.parentId).toBe(seed);
    } else {
      expect(failure).toMatchObject({ name: "SessionSuffixCommittedError" });
      expect(isRecordedModelFallbackStop(failure)).toBe(true);
      expect(() => manager.getBranch()).toThrow("suffix committed");
      const reopened = await SessionManager.openAsync(scope);
      expect(reopened.getLeafId()).toBe(seed);
      expect(reopened.getEntry(removed)).toBeUndefined();
    }
  },
);

it.each(["same", "independent"] as const)(
  "commits awaited rewrites and fences stale %s writers",
  async (writerKind) => {
    const { scope, manager } = await openSession();
    const sourceId = await manager.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "original" }],
      timestamp: 1,
    });
    assert(sourceId, "Missing source message ID");
    await manager.reloadPersistedTranscriptAsync();
    const source = manager.getEntry(sourceId);
    assert(source?.type === "message" && source.message.role === "user", "Missing user source");
    expect(Object.isFrozen(source.message.content)).toBe(false);
    vi.spyOn(manager, "prepareTranscriptRewrite").mockImplementation(() => {
      throw new Error("sync compatibility adapter used");
    });
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    const snapshot = rewrite.sessionManager.getEntry(sourceId);
    assert(
      snapshot?.type === "message" && snapshot.message.role === "user",
      "Missing rewrite user",
    );
    expect(snapshot).not.toBe(source);
    expect(snapshot.message).not.toBe(source.message);
    expect(snapshot.message.content).not.toBe(source.message.content);
    source.message.content = "local replacement";
    expect(snapshot.message.content).toEqual([{ type: "text", text: "original" }]);
    await rewrite.sessionManager.resetLeafAsync();
    const replacementText = "pass: opaque-pass-secret-1234567890";
    const replacementId = await appendUser(rewrite.sessionManager, replacementText);
    await rewrite.commit(new Map([[sourceId, replacementId]]));
    expect(manager.getLeafId()).toBe(replacementId);
    expect(manager.getEntry(replacementId)).toMatchObject({
      message: { content: replacementText },
    });
    const committed = await SessionManager.openAsync(scope);
    expect(committed.getBranch()).toEqual(manager.getBranch());
    expect(committed.getEntry(replacementId)).toEqual(manager.getEntry(replacementId));

    const { replacementId: staleId, ...stale } = await prepareUserRewrite(manager, "stale");
    const writer = writerKind === "same" ? manager : await SessionManager.openAsync(scope);
    const laterId = await writer.appendCustomEntryAsync("later", {});
    await expect(stale.commit(new Map([[replacementId, staleId]]))).rejects.toThrow(
      "changed before rewrite publication",
    );
    expect(writer.getLeafId()).toBe(laterId);
    const reopened = await SessionManager.openAsync(scope);
    expect(reopened.getEntry(staleId)).toBeUndefined();
    expect(reopened.getBranch()).toEqual(writer.getBranch());
  },
);

it("preserves a steer acknowledgment committed after rewrite preparation", async () => {
  const { scope, manager } = await openSession();
  const source = await manager.appendMessageWithTranscriptAnchorAsync(userMessage("steer", 1));
  assert(source.anchor, "Persisted user message must have a transcript anchor");
  const { replacementId, ...rewrite } = await prepareUserRewrite(manager);
  const acknowledged = await rewritePreparedTranscriptMessageAtAnchor(source.anchor, () => ({
    ...source.message,
    __openclaw: { steerTargetRunId: "steered-run" },
  }));
  expect(acknowledged?.generation).toBe(source.anchor.generation);
  await expect(rewrite.commit(new Map([[source.entryId, replacementId]]))).rejects.toThrow(
    "changed before rewrite publication",
  );
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getEntry(replacementId)).toBeUndefined();
  expect(reopened.getEntry(source.entryId)).toMatchObject({
    message: { __openclaw: { steerTargetRunId: "steered-run" } },
  });
});

it("adopts only the submitted rewrite snapshot when the prepared manager changes during its receipt", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  await manager.appendLabelChangeAsync(sourceId, "retained label");
  const { replacementId, ...rewrite } = await prepareUserRewrite(manager);
  let laterPreparedId: string | undefined;
  const observer = afterWorkerCommand("session.transcript.rewrite", async () => {
    laterPreparedId = await appendUser(rewrite.sessionManager, "uncommitted later edit");
  });
  await withRestoredMocks([observer], () => rewrite.commit(new Map([[sourceId, replacementId]])));
  expect(laterPreparedId).toEqual(expect.any(String));
  expect(rewrite.sessionManager.getLeafId()).toBe(laterPreparedId);
  expect(manager.getLeafId()).toBe(replacementId);
  expect(manager.getEntries().map((entry) => entry.id)).not.toContain(laterPreparedId);
  expect(manager.getLabel(sourceId)).toBe("retained label");
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getPersistedEntries()).toEqual(manager.getPersistedEntries());
  expect(reopened.getLeafId()).toBe(replacementId);
});

it.each(["append", "identity", "label", "leaf"] as const)(
  "preserves detached %s edits when rewrite commit is stale",
  async (mutation) => {
    const manager = SessionManager.inMemory();
    const sourceId = await appendUser(manager, "original");
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    const rewrittenIds = new Map<string, string>();
    if (mutation !== "identity") {
      await rewrite.sessionManager.resetLeafAsync();
      rewrittenIds.set(sourceId, await appendUser(rewrite.sessionManager, "replacement"));
    }
    if (mutation === "append") {
      await appendUser(manager, "intervening message");
    } else if (mutation === "identity") {
      manager.newSession({ id: "replacement-session" });
    } else if (mutation === "label") {
      await manager.appendLabelChangeAsync(sourceId, "new label");
    } else {
      await manager.appendLeafControlAsync({ targetId: sourceId, appendParentId: sourceId });
    }
    const expectedEntries = structuredClone(manager.getPersistedEntries());
    const expectedSessionId = manager.getSessionId();
    await expect(rewrite.commit(rewrittenIds)).rejects.toThrow(
      "Session transcript changed before rewrite publication",
    );
    expect(manager.getSessionId()).toBe(expectedSessionId);
    expect(manager.getPersistedEntries()).toEqual(expectedEntries);
  },
);

it("branches a large selected path and rebuilds its new session projection", async () => {
  const { manager } = await openSession("branch-source-v1");
  await appendUser(manager, "selected");
  // Exceed inline projection rebuilding without thousands of fixture writes.
  const selected = await manager.appendCustomEntryAsync("retained", {
    bytes: "x".repeat(4 * 1024 * 1024),
  });
  const omitted = await manager.appendCustomEntryAsync("omit", {});
  const previousSessionId = manager.getSessionId();
  const sessionId = await manager.createBranchedSession(selected);
  expect(sessionId).toBe(manager.getSessionId());
  expect(sessionId).not.toBe(previousSessionId);
  expect(manager.getEntry(omitted)).toBeUndefined();
  const target = manager.getSessionTarget();
  expect(target).toBeDefined();
  await waitForSessionTranscriptProjection(target!);
  expect(
    SessionManager.openBounded(target!, {
      maxEvents: 10,
      maxBytes: 8 * 1024 * 1024,
    }).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  const reopened = await SessionManager.openAsync(target!);
  expect(reopened.getHeader()?.parentSession).toBe(previousSessionId);
  expect(reopened.getBranch()).toEqual(manager.getBranch());
  expect(reopened.getLeafId()).toBe(selected);
});

it("preserves a committed branch and a later target rebinding", async () => {
  const { scope, manager } = await openSession();
  const selected = await appendUser(manager, "selected");
  const replacementScope = {
    ...scope,
    sessionId: "replacement",
    sessionKey: "agent:main:replacement",
  };
  await upsertSessionEntryCore(replacementScope, {
    sessionId: replacementScope.sessionId,
    updatedAt: 1,
  });
  const runExternalRetarget = AsyncLocalStorage.snapshot();
  const original = metadataRuntime.withSessionMetadataWorker;
  const rebindAfterCommit: typeof original = async (...args) => {
    const result = await original(...args);
    await runExternalRetarget(() => manager.setSessionTargetAsync(replacementScope));
    return result;
  };
  const observer = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(rebindAfterCommit);
  const publications: Array<{ sessionId: string | undefined; managerSessionId: string }> = [];
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (mutation.kind !== "delete" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
      publications.push({
        sessionId: mutation.current.sessionId,
        managerSessionId: manager.getSessionId(),
      });
    }
  });
  const branchSessionId = await withRestoredMocks([{ mockRestore: unsubscribe }, observer], () =>
    manager.createBranchedSession(selected),
  );
  const committed = loadSessionEntry(scope);
  expect(committed).toBeDefined();
  expect(committed?.sessionId).not.toBe(scope.sessionId);
  expect(branchSessionId).toBe(committed?.sessionId);
  expect(publications).toContainEqual({
    sessionId: branchSessionId,
    managerSessionId: branchSessionId,
  });
  expect(manager.getSessionId()).toBe(replacementScope.sessionId);
  expect(manager.getSessionTarget()).toMatchObject({
    sessionId: replacementScope.sessionId,
    sessionKey: replacementScope.sessionKey,
  });
  expect([manager.getBranch(), manager.buildSessionContext().messages]).toEqual([[], []]);
  const reopened = await SessionManager.openAsync({ ...scope, sessionId: committed!.sessionId });
  expect(reopened.getLeafId()).toBe(selected);
});
