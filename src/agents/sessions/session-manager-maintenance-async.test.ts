import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "../../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
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
    agentId: "main",
    sessionId: "maintenance",
    sessionKey: "agent:main:maintenance",
    storePath: path.join(tempDirs.make("session-maintenance-"), "sessions.json"),
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
  return (await manager.appendMessageWithTranscriptAnchorAsync(makeUserMessage(text, 1))).entryId;
}

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
  "fences a synchronous navigation change during a suffix %s wait",
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
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    const delayedReceipt: typeof withWorker = (
      options,
      database,
      assertCurrent,
      operation,
      controls,
    ) =>
      withWorker(
        options,
        database,
        assertCurrent,
        (worker) =>
          operation({
            execute: async (command, commandOptions) => {
              const result = await worker.execute(command, commandOptions);
              if (command.type === "session.transcript.replaceSuffix") {
                manager.resetLeaf();
              }
              return result;
            },
          }),
        controls,
      );
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
        : vi.spyOn(metadataRuntime, "withSessionMetadataWorker").mockImplementation(delayedReceipt);
    let failure: unknown;
    try {
      await manager.removeTrailingEntriesAsync((entry) => entry.id === removed);
    } catch (error) {
      failure = error;
    } finally {
      interception.mockRestore();
    }
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

it("commits an awaited rewrite and refuses a stale prepared rewrite without publishing it", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  vi.spyOn(manager, "prepareTranscriptRewrite").mockImplementation(() => {
    throw new Error("sync compatibility adapter used");
  });
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
  await rewrite.commit(new Map([[sourceId, replacementId]]));
  expect(manager.getLeafId()).toBe(replacementId);
  expect((await SessionManager.openAsync(scope)).getBranch()).toEqual(manager.getBranch());

  const stale = await manager.prepareTranscriptRewriteAsync();
  await stale.sessionManager.resetLeafAsync();
  const staleId = await appendUser(stale.sessionManager, "stale");
  const laterId = await manager.appendCustomEntryAsync("later", {});
  await expect(stale.commit(new Map([[replacementId, staleId]]))).rejects.toThrow(
    "changed before rewrite publication",
  );
  expect(manager.getLeafId()).toBe(laterId);
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getEntry(staleId)).toBeUndefined();
  expect(reopened.getBranch()).toEqual(manager.getBranch());
});

it("adopts only the submitted rewrite snapshot when the prepared manager changes during its receipt", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  await manager.appendLabelChangeAsync(sourceId, "retained label");
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
  const withWorker = metadataRuntime.withSessionMetadataWorker;
  let laterPreparedId: string | undefined;
  const mutateAfterCommit: typeof withWorker = (
    options,
    database,
    assertCurrent,
    operation,
    controls,
  ) =>
    withWorker(
      options,
      database,
      assertCurrent,
      (worker) =>
        operation({
          execute: async (command, commandOptions) => {
            const result = await worker.execute(command, commandOptions);
            if (command.type === "session.transcript.rewrite") {
              laterPreparedId = await appendUser(rewrite.sessionManager, "uncommitted later edit");
            }
            return result;
          },
        }),
      controls,
    );
  const observer = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(mutateAfterCommit);
  try {
    await rewrite.commit(new Map([[sourceId, replacementId]]));
  } finally {
    observer.mockRestore();
  }
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
  "preserves an intervening detached %s mutation when rewrite commit is stale",
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

it("retains a committed branch identity and invalidates the view after target rebinding", async () => {
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
  const original = metadataRuntime.withSessionMetadataWorker;
  const rebindAfterCommit: typeof original = async (
    options,
    database,
    assertCurrent,
    operation,
    controls,
  ) => {
    const result = await original(options, database, assertCurrent, operation, controls);
    await manager.setSessionTargetAsync(replacementScope);
    return result;
  };
  const observer = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(rebindAfterCommit);
  const publishedSessionIds: Array<string | undefined> = [];
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (mutation.kind !== "delete" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
      publishedSessionIds.push(mutation.current.sessionId);
    }
  });
  let failure: unknown;
  try {
    await manager.createBranchedSession(selected);
  } catch (error) {
    failure = error;
  } finally {
    observer.mockRestore();
    unsubscribe();
  }
  const committed = loadSessionEntry(scope);
  expect(committed?.sessionId).not.toBe(scope.sessionId);
  expect(failure).toMatchObject({
    name: "SessionBranchCommittedError",
    committedSessionId: committed?.sessionId,
    cause: { message: "Session transcript changed during branch preparation" },
  });
  expect(isRecordedModelFallbackStop(failure)).toBe(true);
  expect(() => manager.getBranch()).toThrow("Session branch committed");
  expect(committed).toBeDefined();
  expect(publishedSessionIds).toContain(committed?.sessionId);
  const reopened = await SessionManager.openAsync({ ...scope, sessionId: committed!.sessionId });
  expect(reopened.getLeafId()).toBe(selected);
});

it("preserves the host's once-redacted rewrite bytes through the worker commit", async () => {
  const { scope, manager } = await openSession();
  const sourceId = await appendUser(manager, "original");
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(
    rewrite.sessionManager,
    "pass: opaque-pass-secret-1234567890",
  );
  await rewrite.commit(new Map([[sourceId, replacementId]]));
  expect(manager.getEntry(replacementId)).toMatchObject({
    message: { content: "pass: opaque…7890" },
  });
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getEntry(replacementId)).toEqual(manager.getEntry(replacementId));
});
