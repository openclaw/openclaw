import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainStoreWriterQueuesForTest } from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWriteAdmission,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../../state/openclaw-agent-write-admission.js";
import { hasModelFallbackStop } from "../failover-error.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { ExtensionEvent, ThinkingLevelSelectEvent } from "./extensions/types.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const startModel = {
  ...testModel,
  provider: "admission-test-provider",
  id: "admission-start",
  contextWindow: 32_768,
  maxTokens: 8_192,
};
const nextModel = { ...startModel, id: "admission-next", reasoning: true };
const lastModel = { ...startModel, id: "admission-last", reasoning: true };
const models = [startModel, nextModel, lastModel];
type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("model transitions after SQLite write admission", () => {
  const releases: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });
  registerAgentSessionLoopTestLifecycle();
  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.allSettled(pending.splice(0));
    await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "model test cleanup");
  });

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }

  async function createModelSession(
    onSelect?: (event: ModelSelectEvent) => Promise<void>,
    onThinkingSelect?: (event: ThinkingLevelSelectEvent) => Promise<void>,
  ) {
    const root = fs.realpathSync(tempDirs.make("openclaw-model-admission-"));
    const target = {
      agentId: "main",
      sessionKey: "agent:main:model-admission",
      sessionId: "model-admission",
      storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const transitions: Array<{ previous: string | undefined; next: string }> = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "model_select",
        [
          async (event) => {
            const selection = event as ModelSelectEvent;
            transitions.push({ previous: selection.previousModel?.id, next: selection.model.id });
            await onSelect?.(selection);
          },
        ],
      ],
      [
        "thinking_level_select",
        [async (event) => await onThinkingSelect?.(event as ThinkingLevelSelectEvent)],
      ],
    ]);
    const resourceLoader = createResourceLoader(handlers);
    const fixture = await createTestSession({
      model: startModel,
      sessionManager: SessionManager.open(target, root),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultThinkingLevel: "medium",
      }),
      resourceLoader,
    });
    fixture.modelRegistry.registerProvider(startModel.provider, {
      api: startModel.api,
      baseUrl: startModel.baseUrl,
      models,
    });
    const options = toDatabaseOptions(resolveSqliteReadScope(target));
    return {
      ...fixture,
      target,
      options,
      transitions,
      extensionRuntime: resourceLoader.getExtensions().runtime,
      readModelChanges: () =>
        SessionManager.open(target, root)
          .getEntries()
          .filter((entry) => entry.type === "model_change")
          .map((entry) => entry.modelId),
    };
  }

  async function holdAdmission(options: Parameters<typeof runOpenClawAgentWriteAdmission>[0]) {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    releases.push(release.resolve);
    const done = track(
      runOpenClawAgentWriteAdmission(options, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    // Callers resume in their own async context, not the reserved owner's reentrant context.
    return { release: release.resolve, done };
  }

  it.runIf(process.platform !== "win32").each(["model", "thinking"] as const)(
    "preserves private database-family modes through a warm %s metadata action",
    async (kind) => {
      const { session, options, target } = await createModelSession();
      await session.setModel(nextModel);
      const databasePath = openOpenClawAgentDatabase(options).path;
      const before = await loadTranscriptEvents(target);
      const files = resolveSqliteDatabaseFilePaths(databasePath).filter((file) =>
        fs.existsSync(file),
      );
      expect(files).toContain(`${databasePath}-wal`);
      for (const file of files) {
        fs.chmodSync(file, 0o644);
        expect(fs.statSync(file).mode & 0o7777).toBe(0o644);
      }

      // Host admission may repair early; native owner tests prove the pre-COMMIT boundary.
      await (kind === "model" ? session.setModel(lastModel) : session.setThinkingLevel("low"));

      for (const file of files) {
        expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
      }
      const after = await loadTranscriptEvents(target);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toMatchObject([
        kind === "model"
          ? { type: "model_change", provider: lastModel.provider, modelId: lastModel.id }
          : { type: "thinking_level_change", thinkingLevel: "low" },
      ]);
    },
  );

  it.each([
    { kind: "model", authority: "current" },
    { kind: "thinking", authority: "current" },
    { kind: "model", authority: "writer" },
    { kind: "thinking", authority: "writer" },
    { kind: "model", authority: "lifecycle" },
    { kind: "thinking", authority: "lifecycle" },
  ] as const)(
    "preserves ambient $authority authority for $kind metadata",
    async ({ kind, authority }) => {
      const thinkingSelections: ThinkingLevelSelectEvent[] = [];
      const { session, sessionManager, settingsManager, options, target, transitions } =
        await createModelSession(undefined, async (event) => {
          thinkingSelections.push(event);
        });
      await session.setModel(nextModel);
      transitions.length = 0;
      thinkingSelections.length = 0;
      const fence = {
        expectedWriterRunId: "metadata-writer",
        expectedLifecycleRevision: "metadata-lifecycle",
      };
      await updateSessionEntry(target, () => ({
        activeWriterRunId: fence.expectedWriterRunId,
        lifecycleRevision: fence.expectedLifecycleRevision,
      }));
      const database = openOpenClawAgentDatabase(options).db;
      const readRows = () =>
        database
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(target.sessionId);
      const readView = () => ({
        entries: sessionManager.getEntries(),
        leaf: sessionManager.getLeafId(),
        context: sessionManager.buildSessionContext(),
        model: session.model?.id,
        thinking: session.thinkingLevel,
        defaultModel: settingsManager.getDefaultModel(),
        defaultThinking: settingsManager.getDefaultThinkingLevel(),
      });
      const beforeRows = readRows();
      const beforeView = structuredClone(readView());
      if (authority !== "current") {
        await updateSessionEntry(target, () =>
          authority === "writer"
            ? { activeWriterRunId: "replacement-writer" }
            : { lifecycleRevision: "replacement-lifecycle" },
        );
      }
      const change = withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...target, ...fence },
          withTranscriptWrite: async (write) => await write(),
        },
        () => (kind === "model" ? session.setModel(lastModel) : session.setThinkingLevel("low")),
      );
      if (authority !== "current") {
        await expect(change).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(readRows()).toEqual(beforeRows);
        expect(readView()).toEqual(beforeView);
        expect(transitions).toEqual([]);
        expect(thinkingSelections).toEqual([]);
        return;
      }
      await expect(change).resolves.toBeUndefined();
      const afterRows = readRows();
      expect(afterRows.slice(0, beforeRows.length)).toEqual(beforeRows);
      expect(afterRows).toHaveLength(beforeRows.length + 1);
      expect(sessionManager.getEntries().at(-1)).toMatchObject(
        kind === "model"
          ? { type: "model_change", modelId: lastModel.id }
          : { type: "thinking_level_change", thinkingLevel: "low" },
      );
      expect(session.model?.id).toBe(kind === "model" ? lastModel.id : nextModel.id);
      expect(session.thinkingLevel).toBe(kind === "thinking" ? "low" : "medium");
      expect(settingsManager.getDefaultModel()).toBe(session.model?.id);
      expect(settingsManager.getDefaultThinkingLevel()).toBe(session.thinkingLevel);
      expect(transitions).toHaveLength(kind === "model" ? 1 : 0);
      expect(thinkingSelections).toHaveLength(kind === "thinking" ? 1 : 0);
    },
  );

  it("refuses detached queued metadata after its session identity changes", async () => {
    const manager = SessionManager.inMemory();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    releases.push(release.resolve);
    const held = track(
      withSessionManagerWrite(manager, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const change = track(manager.appendThinkingLevelChange("high"));
    manager.newSession({ id: "replacement-detached-session" });
    release.resolve();
    await expect(change).rejects.toThrow("Session manager identity changed");
    await held;
    expect(manager.getEntries()).toEqual([]);
    expect(manager.getSessionId()).toBe("replacement-detached-session");
  });

  it("keeps replacement lazy-header bookkeeping when an old header commits", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-header-adoption-"));
    const target = {
      agentId: "main",
      sessionKey: "agent:main:header-before-rebind",
      sessionId: "header-before-rebind",
      storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
    };
    const replacement = {
      ...target,
      sessionKey: "agent:main:header-after-rebind",
      sessionId: "header-after-rebind",
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 2 });
    const manager = SessionManager.open(target, root);
    const original = metadataRuntime.withSessionMetadataWorker;
    let rebound = false;
    const observeHeader: typeof original = async (options, database, assertCurrent, operation) =>
      await original(options, database, assertCurrent, (scope) =>
        operation({
          execute: async (command, commandOptions) => {
            const reply = await scope.execute(command, commandOptions);
            // The durable assertions below verify that only the lazy header committed.
            if (command.type === "session.metadata.append" && !rebound) {
              rebound = true;
              manager.setSessionTarget(replacement);
            }
            return reply;
          },
        }),
      );
    const observed = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation(observeHeader);
    try {
      await expect(manager.appendModelChange("test-provider", "old-model")).rejects.toThrow();
    } finally {
      observed.mockRestore();
    }
    expect(rebound).toBe(true);
    expect(await loadTranscriptEvents(target)).toMatchObject([{ type: "session" }]);
    expect(await loadTranscriptEvents(replacement)).toEqual([]);
    await manager.appendModelChange("test-provider", "replacement-model");
    expect(await loadTranscriptEvents(replacement)).toMatchObject([
      { type: "session", id: replacement.sessionId },
      { type: "model_change", modelId: "replacement-model" },
    ]);
    expect(SessionManager.open(replacement, root).getEntries()).toEqual(manager.getEntries());
  });

  it.each(["model", "thinking"] as const)(
    "rejects $0 metadata from an extension invalidated while queued",
    async (kind) => {
      const { session, settingsManager, options, target, extensionRuntime } =
        await createModelSession();
      await session.setModel(nextModel);
      const before = await loadTranscriptEvents(target);
      const reservation = await holdAdmission(options);
      const change = track<boolean | void>(
        kind === "model"
          ? extensionRuntime.setModel(lastModel)
          : extensionRuntime.setThinkingLevel("low"),
      );
      extensionRuntime.invalidate("extension invalidated during metadata admission");
      reservation.release();
      await expect(change).rejects.toThrow("extension invalidated during metadata admission");
      await reservation.done;
      expect(await loadTranscriptEvents(target)).toEqual(before);
      expect(session.model?.id).toBe(nextModel.id);
      expect(session.thinkingLevel).toBe("medium");
      expect(settingsManager.getDefaultModel()).toBe(nextModel.id);
      expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
    },
  );

  it.each([lastModel, startModel])(
    "does not overwrite a replacement session after $id model append settles",
    async (selectedModel) => {
      const { session, sessionManager, settingsManager, target, readModelChanges } =
        await createModelSession();
      await session.setModel(nextModel);
      const replacement = {
        ...target,
        sessionId: "replacement-after-settlement",
        sessionKey: "agent:main:replacement-after-settlement",
      };
      await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 2 });
      const replacementManager = SessionManager.open(replacement);
      await replacementManager.appendModelChange(nextModel.provider, nextModel.id);
      await replacementManager.appendThinkingLevelChange("high");
      const replacementEntries = await loadTranscriptEvents(replacement);
      const append = sessionManager.appendModelChange.bind(sessionManager);
      const settled = vi
        .spyOn(sessionManager, "appendModelChange")
        .mockImplementation(async (provider, modelId) => {
          const id = await append(provider, modelId);
          sessionManager.setSessionTarget(replacement);
          session.agent.state.model = nextModel;
          session.agent.state.thinkingLevel = "high";
          settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
          settingsManager.setDefaultThinkingLevel("high");
          return id;
        });
      try {
        const failure: unknown = await session
          .setModel(selectedModel)
          .catch((error: unknown) => error);
        expect(readModelChanges()).toEqual([startModel.id, nextModel.id, selectedModel.id]);
        expect(await loadTranscriptEvents(replacement)).toEqual(replacementEntries);
        expect(session.model?.id).toBe(nextModel.id);
        expect(session.thinkingLevel).toBe("high");
        expect(settingsManager.getDefaultModel()).toBe(nextModel.id);
        expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
        if (failure !== undefined || selectedModel === startModel) {
          expect(failure).toMatchObject({ committedTarget: target });
        }
      } finally {
        settled.mockRestore();
      }
    },
  );

  it("keeps a committed model result when its extension invalidates during notification", async () => {
    let invalidate = () => {};
    const { session, extensionRuntime, readModelChanges } = await createModelSession(async () =>
      invalidate(),
    );
    invalidate = () => extensionRuntime.invalidate("extension invalidated after commit");
    await expect(extensionRuntime.setModel(nextModel)).resolves.toBe(true);
    expect(session.model?.id).toBe(nextModel.id);
    expect(readModelChanges()).toEqual([startModel.id, nextModel.id]);
  });

  it("retains the committed receipt when scalar publication fails", async () => {
    const { session, sessionManager, settingsManager, target, readModelChanges } =
      await createModelSession();
    await session.setModel(nextModel);
    const publicationFailure = new Error("Scalar publication failed");
    publicationFailure.name = "SqliteTranscriptMutationConflictError";
    const publication = vi
      .spyOn(settingsManager, "setDefaultModelAndProvider")
      .mockImplementationOnce(() => {
        throw publicationFailure;
      });
    try {
      const failure: unknown = await session.setModel(lastModel).catch((error: unknown) => error);
      expect(readModelChanges()).toEqual([startModel.id, nextModel.id, lastModel.id]);
      expect(session.model?.id).toBe(lastModel.id);
      expect(settingsManager.getDefaultModel()).toBe(nextModel.id);
      expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
      expect(failure).toMatchObject({
        committedTarget: target,
        committedEntry: { type: "model_change", modelId: lastModel.id },
        cause: publicationFailure,
      });
      expect(hasModelFallbackStop(failure)).toBe(true);
      expect(() => sessionManager.getEntries()).toThrow(failure);
      expect(publication).toHaveBeenCalledOnce();
    } finally {
      publication.mockRestore();
    }
  });

  it.each(["extension", "manager", "manager-after-close"] as const)(
    "settles the committed result when the %s changes at the result boundary",
    async (changedOwner) => {
      const {
        session,
        sessionManager,
        settingsManager,
        extensionRuntime,
        target,
        readModelChanges,
      } = await createModelSession();
      await session.setModel(nextModel);
      const replacement = {
        ...target,
        sessionId: "replacement-after-commit",
        sessionKey: "agent:main:replacement-after-commit",
      };
      if (changedOwner !== "extension") {
        await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 2 });
      }
      const external = SessionManager.open(target);
      const externalEntry = external.appendMessage({
        role: "user",
        content: "A newer durable turn",
        timestamp: 2,
      });
      const original = metadataRuntime.withSessionMetadataWorker;
      let invalidated = false;
      const observeCommittedResult: typeof original = async (
        options,
        database,
        assertCurrent,
        operation,
      ) => {
        const result = await original(options, database, assertCurrent, (scope) =>
          operation({
            execute: async (command, commandOptions) => {
              const reply = await scope.execute(command, commandOptions);
              if (command.type === "session.metadata.append") {
                invalidated = true;
                if (changedOwner === "extension") {
                  extensionRuntime.invalidate("extension invalidated after metadata commit");
                } else if (changedOwner === "manager") {
                  sessionManager.setSessionTarget(replacement);
                }
              }
              return reply;
            },
          }),
        );
        if (changedOwner === "manager-after-close") {
          sessionManager.setSessionTarget(replacement);
        }
        return result;
      };
      const observer = vi
        .spyOn(metadataRuntime, "withSessionMetadataWorker")
        .mockImplementation(observeCommittedResult);
      try {
        const change = extensionRuntime.setModel(lastModel);
        if (changedOwner === "extension") {
          await expect(change).resolves.toBe(true);
        } else {
          await expect(change).rejects.toMatchObject({
            name: "SessionMetadataCommittedError",
            committedTarget: target,
            committedEntry: { type: "model_change", modelId: lastModel.id },
          });
        }
        expect(invalidated).toBe(true);
        expect(session.model?.id).toBe(changedOwner === "extension" ? lastModel.id : nextModel.id);
        expect(settingsManager.getDefaultModel()).toBe(
          changedOwner === "extension" ? lastModel.id : nextModel.id,
        );
        if (changedOwner === "extension") {
          expect(sessionManager.getBranch().map((entry) => entry.id)).toContain(externalEntry);
        } else {
          expect(sessionManager.getSessionTarget()).toMatchObject(replacement);
          expect(() => sessionManager.getBranch()).toThrow(SessionMetadataCommittedError);
          expect(SessionManager.open(replacement).getEntries()).toEqual([]);
        }
        expect(readModelChanges()).toEqual([startModel.id, nextModel.id, lastModel.id]);
      } finally {
        observer.mockRestore();
      }
    },
  );

  it.each(["model", "thinking"] as const)(
    "retains committed %s metadata when the stale transcript view cannot be decoded",
    async (kind) => {
      const { session, sessionManager, settingsManager, options, target } =
        await createModelSession();
      await session.setModel(nextModel);
      const firstModel = sessionManager.getEntries().find((entry) => entry.type === "model_change");
      if (!firstModel) {
        throw new Error("Fixture must contain its initial model");
      }
      const external = SessionManager.open(target);
      external.appendMessage({ role: "user", content: "Newer durable turn", timestamp: 2 });
      const database = openOpenClawAgentDatabase(options).db;
      const original = database
        .prepare(
          "SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
        )
        .get(target.sessionId, target.sessionId, firstModel.id)?.event_json;
      if (typeof original !== "string") {
        throw new Error("Fixture must retain its original transcript bytes");
      }
      database
        .prepare(
          "UPDATE transcript_events SET event_json = '{invalid-prior-event' WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
        )
        .run(target.sessionId, target.sessionId, firstModel.id);
      const before = database
        .prepare("SELECT MAX(seq) AS seq FROM transcript_events WHERE session_id = ?")
        .get(target.sessionId)?.seq;
      if (typeof before !== "number") {
        throw new Error("Fixture must contain transcript rows");
      }

      const failure: unknown = await (
        kind === "model" ? session.setModel(lastModel) : session.setThinkingLevel("low")
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
      expect(failure).toMatchObject({ cause: { name: "SyntaxError" } });

      const appended = database
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq > ?")
        .all(target.sessionId, before);
      expect(appended).toHaveLength(1);
      const expectedEntry =
        kind === "model"
          ? { type: "model_change", modelId: lastModel.id }
          : { type: "thinking_level_change", thinkingLevel: "low" };
      expect(JSON.parse(String(appended[0]?.event_json))).toMatchObject(expectedEntry);
      expect(session.model?.id).toBe(kind === "model" ? lastModel.id : nextModel.id);
      expect(settingsManager.getDefaultModel()).toBe(
        kind === "model" ? lastModel.id : nextModel.id,
      );
      expect(session.thinkingLevel).toBe(kind === "thinking" ? "low" : "medium");
      expect(settingsManager.getDefaultThinkingLevel()).toBe(
        kind === "thinking" ? "low" : "medium",
      );
      for (const read of [
        () => sessionManager.getEntries(),
        () => sessionManager.getBranch(),
        () => sessionManager.getTree(),
        () => sessionManager.buildSessionContext(),
        () => sessionManager.prepareTranscriptRewrite(),
      ]) {
        expect(read).toThrow(failure);
      }
      expect(sessionManager.getSessionTarget()).toMatchObject(target);
      expect(sessionManager.getSessionId()).toBe(target.sessionId);
      database
        .prepare(
          "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
        )
        .run(original, target.sessionId, target.sessionId, firstModel.id);
      expect(() => sessionManager.getEntries()).toThrow(failure);
      expect(SessionManager.open(target).getEntries().at(-1)).toMatchObject(expectedEntry);
    },
  );

  it("inherits thinking and reports the model actually replaced by each queued transition", async () => {
    const { session, settingsManager, options, transitions, readModelChanges } =
      await createModelSession();
    const reservation = await holdAdmission(options);
    const first = track(session.setModel(nextModel));
    const second = track(session.setModel(lastModel));
    expect(session.model?.id).toBe(startModel.id);
    expect(transitions).toEqual([]);
    reservation.release();
    await Promise.all([reservation.done, first, second]);

    expect(readModelChanges()).toEqual(models.map((model) => model.id));
    expect.soft(transitions).toEqual([
      { previous: startModel.id, next: nextModel.id },
      { previous: nextModel.id, next: lastModel.id },
    ]);
    expect.soft(session.thinkingLevel).toBe("medium");
    expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
  });

  it("rejects a queued model switch when its configured auth was removed before admission", async () => {
    const { session, modelRegistry, settingsManager, target, options, transitions } =
      await createModelSession();
    const before = await loadTranscriptEvents(target);
    const defaults = {
      provider: settingsManager.getDefaultProvider(),
      model: settingsManager.getDefaultModel(),
      thinking: settingsManager.getDefaultThinkingLevel(),
    };
    expect(modelRegistry.hasConfiguredAuth(nextModel)).toBe(true);
    const reservation = await holdAdmission(options);
    const change = track(session.setModel(nextModel));
    modelRegistry.authStorage.removeRuntimeApiKey(nextModel.provider);
    expect(modelRegistry.hasConfiguredAuth(nextModel)).toBe(false);
    reservation.release();
    const outcomes = await Promise.allSettled([change]);
    await reservation.done;

    expect.soft(outcomes).toEqual([
      {
        status: "rejected",
        reason: new Error(`No API key for ${nextModel.provider}/${nextModel.id}`),
      },
    ]);
    expect.soft(session.model?.id).toBe(startModel.id);
    expect.soft(await loadTranscriptEvents(target)).toEqual(before);
    expect.soft(transitions).toEqual([]);
    expect({
      provider: settingsManager.getDefaultProvider(),
      model: settingsManager.getDefaultModel(),
      thinking: settingsManager.getDefaultThinkingLevel(),
    }).toEqual(defaults);
  });

  it("settles queued thinking changes before adopting settings or notifying hooks", async () => {
    const thinkingSelections: ThinkingLevelSelectEvent[] = [];
    const { session, settingsManager, options, target } = await createModelSession(
      undefined,
      async (event) => {
        thinkingSelections.push(event);
      },
    );
    await session.setModel(nextModel);
    thinkingSelections.length = 0;
    const before = await loadTranscriptEvents(target);
    const reservation = await holdAdmission(options);
    const first = track(session.setThinkingLevel("low"));
    const second = track(session.setThinkingLevel("high"));

    expect(session.thinkingLevel).toBe("medium");
    expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
    expect(thinkingSelections).toEqual([]);
    reservation.release();
    await Promise.all([reservation.done, first, second]);

    expect(session.thinkingLevel).toBe("high");
    expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
    expect(thinkingSelections).toEqual([
      { type: "thinking_level_select", level: "low", previousLevel: "medium" },
      { type: "thinking_level_select", level: "high", previousLevel: "low" },
    ]);
    expect((await loadTranscriptEvents(target)).slice(before.length)).toMatchObject([
      { type: "thinking_level_change", thinkingLevel: "low" },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ]);
  });

  it("releases admission before model hooks settle", async () => {
    const hookEntered = createDeferredCore();
    const releaseHook = createDeferredCore();
    releases.push(releaseHook.resolve);
    const { session, options, transitions, readModelChanges } = await createModelSession(
      async (event) => {
        if (event.model.id === nextModel.id) {
          hookEntered.resolve();
          await releaseHook.promise;
        }
      },
    );
    const reservation = await holdAdmission(options);
    const change = track(session.setModel(nextModel));
    reservation.release();
    await hookEntered.promise;
    await reservation.done;

    // A separate caller must finish while the first transition's extension hook is still pending.
    await track(session.setModel(startModel));
    expect(session.thinkingLevel).toBe("off");
    expect(readModelChanges()).toEqual([startModel.id, nextModel.id, startModel.id]);
    expect(transitions).toEqual([
      { previous: startModel.id, next: nextModel.id },
      { previous: nextModel.id, next: startModel.id },
    ]);
    releaseHook.resolve();
    await expect(change).resolves.toBeUndefined();
  });

  it("keeps a thinking hook's model transition behind an already queued writer", async () => {
    const hookSettled = createDeferredCore();
    const { session, options, readModelChanges } = await createModelSession(undefined, async () => {
      await track(session.setModel(lastModel));
      hookSettled.resolve();
    });
    const reservation = await holdAdmission(options);
    const change = track(session.setModel(nextModel));
    let modelSeenByPeer: string | undefined;
    const peer = track(
      runOpenClawAgentWriteAdmission(options, () => {
        modelSeenByPeer = session.model?.id;
      }),
    );
    reservation.release();
    await Promise.all([reservation.done, change, peer, hookSettled.promise]);

    expect(modelSeenByPeer).toBe(nextModel.id);
    expect(readModelChanges()).toEqual(models.map((model) => model.id));
  });

  it("rejects a queued switch after its manager is rebound to another session", async () => {
    const { session, sessionManager, target, options, transitions } = await createModelSession();
    const replacementTarget = {
      ...target,
      sessionId: "replacement",
      sessionKey: "agent:main:replacement",
    };
    await replaceSessionEntry(replacementTarget, {
      sessionId: replacementTarget.sessionId,
      updatedAt: 1,
    });
    const before = await loadTranscriptEvents(target);
    const replacementBefore = await loadTranscriptEvents(replacementTarget);
    const reservation = await holdAdmission(options);
    const change = track(session.setModel(nextModel));
    sessionManager.setSessionTarget(replacementTarget);
    reservation.release();

    await expect(change).rejects.toThrow("Session manager identity changed");
    await reservation.done;
    expect(session.model?.id).toBe(startModel.id);
    expect(transitions).toEqual([]);
    expect(await loadTranscriptEvents(target)).toEqual(before);
    expect(await loadTranscriptEvents(replacementTarget)).toEqual(replacementBefore);
  });
});
