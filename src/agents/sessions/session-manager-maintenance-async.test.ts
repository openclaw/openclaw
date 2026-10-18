import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
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

it("prepares and publishes a 50 MiB transcript without copying immutable payloads", async () => {
  const manager = SessionManager.inMemory("/synthetic");
  const id = await manager.appendCustomEntryAsync("large-tool-output", {
    chunks: Array.from({ length: 50 * 1024 }, () => ({ text: "x".repeat(1024) })),
  });
  const original = manager.getEntry(id);
  if (original?.type !== "custom" || !isRecord(original.data)) {
    throw new Error("Missing large transcript payload");
  }
  const started = performance.now();
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  expect(performance.now() - started).toBeLessThan(50);
  expect(rewrite.sessionManager.getEntry(id)).toBe(original);
  expect(Object.isFrozen(original)).toBe(true);
  expect(Object.isFrozen(original.data)).toBe(true);
  expect(Reflect.set(original.data, "chunks", [])).toBe(false);
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
  expect(manager.getEntry(replacementId)).toBeUndefined();
  const publishing = performance.now();
  await rewrite.commit(new Map());
  expect(performance.now() - publishing).toBeLessThan(50);
  expect(manager.getEntry(id)).toBe(original);
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
  if (entry?.type !== "custom" || !isRecord(entry.data)) {
    throw new Error("Missing custom entry");
  }
  const record = rewrite.sessionManager
    .getPersistedEntries()
    .find((value) => isRecord(value) && value.type === "opaque");
  if (!isRecord(record)) {
    throw new Error("Missing opaque record");
  }
  expect(record.shared).toBe(entry.data);
  if (opaque) {
    if (!(record.bytes instanceof Uint8Array)) {
      throw new Error("Missing opaque bytes");
    }
    expect(record.bytes.buffer).toBe(record.buffer);
    expect(record.buffer).not.toBe(buffer);
  }
  entry.data.text = "prepared";
  expect(manager.getEntry("data")).toMatchObject({ data: { text: "original" } });
  await rewrite.commit(new Map());
  const committed = manager.getEntry("data");
  expect(committed).toMatchObject({ data: { text: "prepared" } });
  expect(committed).not.toBe(entry);
  entry.data.text = "later";
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

it.each(["same", "independent"] as const)(
  "commits an awaited rewrite and refuses a stale rewrite after a %s manager writes",
  async (writerKind) => {
    const { scope, manager } = await openSession();
    const sourceId = await manager.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: "original" }],
      timestamp: 1,
    });
    if (!sourceId) {
      throw new Error("Missing source message ID");
    }
    await manager.reloadPersistedTranscriptAsync();
    const source = manager.getEntry(sourceId);
    if (source?.type !== "message" || source.message.role !== "user") {
      throw new Error("Missing hydrated source message");
    }
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.message.content)).toBe(true);
    vi.spyOn(manager, "prepareTranscriptRewrite").mockImplementation(() => {
      throw new Error("sync compatibility adapter used");
    });
    const rewrite = await manager.prepareTranscriptRewriteAsync();
    const snapshot = rewrite.sessionManager.getEntry(sourceId);
    if (snapshot?.type !== "message" || snapshot.message.role !== "user") {
      throw new Error("Missing rewrite source message");
    }
    expect(snapshot).not.toBe(source);
    expect(snapshot.message).not.toBe(source.message);
    expect(snapshot.message.content).toBe(source.message.content);
    source.message.content = "local replacement";
    expect(snapshot.message.content).toEqual([{ type: "text", text: "original" }]);
    await rewrite.sessionManager.resetLeafAsync();
    const replacementId = await appendUser(rewrite.sessionManager, "replacement");
    await rewrite.commit(new Map([[sourceId, replacementId]]));
    expect(manager.getLeafId()).toBe(replacementId);
    expect((await SessionManager.openAsync(scope)).getBranch()).toEqual(manager.getBranch());

    const stale = await manager.prepareTranscriptRewriteAsync();
    await stale.sessionManager.resetLeafAsync();
    const staleId = await appendUser(stale.sessionManager, "stale");
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
  const source = await manager.appendMessageWithTranscriptAnchorAsync(makeUserMessage("steer", 1));
  if (!source.anchor) {
    throw new Error("Persisted user message must have a transcript anchor");
  }
  const rewrite = await manager.prepareTranscriptRewriteAsync();
  await rewrite.sessionManager.resetLeafAsync();
  const replacementId = await appendUser(rewrite.sessionManager, "replacement");
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
  const rebindAfterCommit: typeof original = async (
    options,
    database,
    assertCurrent,
    operation,
    controls,
  ) => {
    const result = await original(options, database, assertCurrent, operation, controls);
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
  let branchSessionId: string | undefined;
  try {
    branchSessionId = await manager.createBranchedSession(selected);
  } finally {
    observer.mockRestore();
    unsubscribe();
  }
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
  expect(manager.getBranch()).toEqual([]);
  expect(manager.buildSessionContext().messages).toEqual([]);
  const reopened = await SessionManager.openAsync({ ...scope, sessionId: committed!.sessionId });
  expect(reopened.getLeafId()).toBe(selected);
});

it("preserves source rewrite bytes through the worker commit", async () => {
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
    message: { content: "pass: opaque-pass-secret-1234567890" },
  });
  const reopened = await SessionManager.openAsync(scope);
  expect(reopened.getEntry(replacementId)).toEqual(manager.getEntry(replacementId));
});
