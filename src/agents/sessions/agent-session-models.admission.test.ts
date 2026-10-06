import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
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
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
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

async function closeDatabaseRoots(roots: Iterable<string>) {
  for (const root of roots) {
    await closeOpenClawAgentDatabasesAsync(root);
    closeOpenClawAgentDatabasesForTest(root);
  }
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeDatabaseRoots(tempDirs.dirs);
    cleanup();
  }),
);
const suiteTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeDatabaseRoots(suiteTempDirs.dirs);
    cleanup();
  }),
);
let suiteRoot: string | undefined;
let nextFixtureId = 0;

describe("model transitions after SQLite write admission", () => {
  const releases: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];

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
    rootOverride?: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const root =
      rootOverride ??
      (env
        ? fs.realpathSync(tempDirs.make("openclaw-model-admission-"))
        : (suiteRoot ??= suiteTempDirs.make("openclaw-model-admission-")));
    const sessionId = `model-admission-${++nextFixtureId}`;
    const target = {
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      sessionId,
      storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
      ...(env ? { env } : {}),
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

  it("keeps captured storage environment out of metadata command payloads", async () => {
    const stateDir = fs.realpathSync(tempDirs.make("metadata-context-environment-"));
    const original = metadataRuntime.withSessionMetadataWorker;
    const commands = new Set<string>();
    const observeCommands: typeof original = async (
      options,
      database,
      assertCurrent,
      operation,
    ) => {
      expect(options.env?.OPENCLAW_STATE_DIR).toBe(stateDir);
      return await original(options, database, assertCurrent, (scope) =>
        operation({
          execute: async (command, commandOptions) => {
            expect(command.input.scope).not.toHaveProperty("env");
            commands.add(command.type);
            return await scope.execute(command, commandOptions);
          },
        }),
      );
    };
    const observer = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation(observeCommands);
    try {
      const { session, sessionManager, target } = await createModelSession(
        undefined,
        undefined,
        undefined,
        { OPENCLAW_STATE_DIR: stateDir },
      );
      const before = await loadTranscriptEvents(target);
      await session.setModel(nextModel);
      expect(commands).toEqual(new Set(["session.metadata.initialize", "session.metadata.append"]));
      expect(sessionManager.getSessionTarget()?.env?.OPENCLAW_STATE_DIR).toBe(stateDir);
      const after = await loadTranscriptEvents(target);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toMatchObject([
        { type: "model_change", modelId: nextModel.id },
        { type: "thinking_level_change", thinkingLevel: "medium" },
      ]);
      expect(session.model?.id).toBe(nextModel.id);
    } finally {
      observer.mockRestore();
    }
  });

  it.each([
    { kind: "model", authority: "current" },
    { kind: "model", authority: "writer" },
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
      expect(sessionManager.getEntries().at(-1)).toMatchObject({
        type: "model_change",
        modelId: lastModel.id,
      });
      expect(session.model?.id).toBe(lastModel.id);
      expect(session.thinkingLevel).toBe("medium");
      expect(settingsManager.getDefaultModel()).toBe(session.model?.id);
      expect(settingsManager.getDefaultThinkingLevel()).toBe(session.thinkingLevel);
      expect(transitions).toHaveLength(1);
      expect(thinkingSelections).toHaveLength(0);
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

  it.each(["auth", "extension", "session", "storage-root"] as const)(
    "rejects queued metadata after its %s authority changes",
    async (kind) => {
      const env =
        kind === "storage-root"
          ? { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("metadata-root-first-")) }
          : undefined;
      const {
        session,
        sessionManager,
        settingsManager,
        modelRegistry,
        options,
        target,
        extensionRuntime,
        transitions,
      } = await createModelSession(undefined, undefined, undefined, env);
      if (kind === "extension" || kind === "storage-root") {
        await session.setModel(nextModel);
      }
      const before = await loadTranscriptEvents(target);
      const defaults = {
        provider: settingsManager.getDefaultProvider(),
        model: settingsManager.getDefaultModel(),
        thinking: settingsManager.getDefaultThinkingLevel(),
      };
      const replacement =
        kind === "storage-root"
          ? {
              ...target,
              env: { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("metadata-root-second-")) },
            }
          : {
              ...target,
              sessionId: `${target.sessionId}-replacement`,
              sessionKey: `${target.sessionKey}-replacement`,
            };
      if (kind === "session") {
        await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
      }
      const replacementBefore = kind === "session" ? await loadTranscriptEvents(replacement) : [];
      if (kind === "auth") {
        expect(modelRegistry.hasConfiguredAuth(nextModel)).toBe(true);
      }
      const reservation = await holdAdmission(options);
      const change = track<unknown>(
        kind === "extension"
          ? extensionRuntime.setThinkingLevel("low")
          : kind === "storage-root"
            ? sessionManager.appendModelChange(lastModel.provider, lastModel.id)
            : session.setModel(nextModel),
      );
      try {
        if (kind === "auth") {
          modelRegistry.authStorage.removeRuntimeApiKey(nextModel.provider);
          expect(modelRegistry.hasConfiguredAuth(nextModel)).toBe(false);
        } else if (kind === "extension") {
          extensionRuntime.invalidate("extension invalidated during metadata admission");
        } else {
          sessionManager.setSessionTarget(replacement);
          expect(sessionManager.getSessionTarget()).toMatchObject(replacement);
        }
      } finally {
        reservation.release();
      }
      const outcomes = await Promise.allSettled([change]);
      await reservation.done;
      expect.soft(await loadTranscriptEvents(target)).toEqual(before);
      if (kind === "auth") {
        expect.soft(outcomes).toEqual([
          {
            status: "rejected",
            reason: new Error(`No API key for ${nextModel.provider}/${nextModel.id}`),
          },
        ]);
        expect({
          provider: settingsManager.getDefaultProvider(),
          model: settingsManager.getDefaultModel(),
          thinking: settingsManager.getDefaultThinkingLevel(),
        }).toEqual(defaults);
      } else if (kind === "storage-root") {
        const outcome = outcomes[0];
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(outcome.reason).not.toBeInstanceOf(SessionMetadataCommittedError);
        }
      } else {
        await expect(change).rejects.toThrow(
          kind === "extension"
            ? "extension invalidated during metadata admission"
            : "Session manager identity changed",
        );
      }
      if (kind === "extension") {
        expect(session.model?.id).toBe(nextModel.id);
        expect(session.thinkingLevel).toBe("medium");
        expect(settingsManager.getDefaultModel()).toBe(nextModel.id);
        expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
      } else if (kind !== "storage-root") {
        expect.soft(session.model?.id).toBe(startModel.id);
        expect.soft(transitions).toEqual([]);
        if (kind === "session") {
          expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
        }
      }
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
        sessionId: `${target.sessionId}-replacement-after-settlement`,
        sessionKey: `${target.sessionKey}-replacement-after-settlement`,
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

  it("retains the committed receipt when scalar publication fails", async () => {
    const { session, sessionManager, settingsManager, target, readModelChanges } =
      await createModelSession();
    await session.setModel(nextModel);
    const publicationFailure = new SqliteTranscriptMutationConflictError(target.sessionId);
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

  it.each(["extension", "extension-notification", "manager", "manager-after-close"] as const)(
    "settles the committed result when the %s changes at the result boundary",
    async (changedOwner) => {
      let invalidate = () => {};
      const {
        session,
        sessionManager,
        settingsManager,
        extensionRuntime,
        target,
        readModelChanges,
      } = await createModelSession(async () => invalidate());
      const duringNotification = changedOwner === "extension-notification";
      const changesExtension = changedOwner === "extension" || duringNotification;
      const selectedModel = duringNotification ? nextModel : lastModel;
      if (duringNotification) {
        invalidate = () => extensionRuntime.invalidate("extension invalidated after commit");
      } else {
        await session.setModel(nextModel);
      }
      const replacement = {
        ...target,
        sessionId: `${target.sessionId}-replacement-after-commit`,
        sessionKey: `${target.sessionKey}-replacement-after-commit`,
      };
      if (!changesExtension) {
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
        const change = extensionRuntime.setModel(selectedModel);
        if (changesExtension) {
          await expect(change).resolves.toBe(true);
        } else {
          await expect(change).rejects.toMatchObject({
            name: "SessionMetadataCommittedError",
            committedTarget: target,
            committedEntry: { type: "model_change", modelId: lastModel.id },
          });
        }
        expect(invalidated).toBe(true);
        expect(session.model?.id).toBe(changesExtension ? selectedModel.id : nextModel.id);
        expect(settingsManager.getDefaultModel()).toBe(
          changesExtension ? selectedModel.id : nextModel.id,
        );
        if (changesExtension) {
          expect(sessionManager.getBranch().map((entry) => entry.id)).toContain(externalEntry);
        } else {
          expect(sessionManager.getSessionTarget()).toMatchObject(replacement);
          expect(() => sessionManager.getBranch()).toThrow(SessionMetadataCommittedError);
          expect(SessionManager.open(replacement).getEntries()).toEqual([]);
        }
        expect(readModelChanges()).toEqual(
          duringNotification
            ? [startModel.id, nextModel.id]
            : [startModel.id, nextModel.id, lastModel.id],
        );
      } finally {
        observer.mockRestore();
      }
    },
  );

  it("retains committed thinking metadata when the stale transcript view cannot be decoded", async () => {
    const root = tempDirs.make("openclaw-model-admission-corruption-");
    const { session, sessionManager, settingsManager, options, target } = await createModelSession(
      undefined,
      undefined,
      root,
    );
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

    const failure: unknown = await session.setThinkingLevel("low").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
    expect(failure).toMatchObject({ cause: { name: "SyntaxError" } });

    const appended = database
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq > ?")
      .all(target.sessionId, before);
    expect(appended).toHaveLength(1);
    const expectedEntry = { type: "thinking_level_change", thinkingLevel: "low" };
    expect(JSON.parse(String(appended[0]?.event_json))).toMatchObject(expectedEntry);
    expect(session.model?.id).toBe(nextModel.id);
    expect(settingsManager.getDefaultModel()).toBe(nextModel.id);
    expect(session.thinkingLevel).toBe("low");
    expect(settingsManager.getDefaultThinkingLevel()).toBe("low");
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
  });

  it.each(["model", "thinking"] as const)(
    "publishes queued %s changes in order after admission",
    async (kind) => {
      const thinkingSelections: ThinkingLevelSelectEvent[] = [];
      const { session, settingsManager, options, target, transitions, readModelChanges } =
        await createModelSession(undefined, async (event) => {
          thinkingSelections.push(event);
        });
      if (kind === "thinking") {
        await session.setModel(nextModel);
        thinkingSelections.length = 0;
      }
      const before = await loadTranscriptEvents(target);
      const reservation = await holdAdmission(options);
      const first = track(
        kind === "model" ? session.setModel(nextModel) : session.setThinkingLevel("low"),
      );
      const second = track(
        kind === "model" ? session.setModel(lastModel) : session.setThinkingLevel("high"),
      );
      if (kind === "model") {
        expect(session.model?.id).toBe(startModel.id);
        expect(transitions).toEqual([]);
      } else {
        expect(session.thinkingLevel).toBe("medium");
        expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
        expect(thinkingSelections).toEqual([]);
      }
      reservation.release();
      await Promise.all([reservation.done, first, second]);
      expect.soft(session.thinkingLevel).toBe(kind === "model" ? "medium" : "high");
      expect(settingsManager.getDefaultThinkingLevel()).toBe(kind === "model" ? "medium" : "high");
      if (kind === "model") {
        expect(readModelChanges()).toEqual(models.map((model) => model.id));
        expect.soft(transitions).toEqual([
          { previous: startModel.id, next: nextModel.id },
          { previous: nextModel.id, next: lastModel.id },
        ]);
      } else {
        expect(thinkingSelections).toEqual([
          { type: "thinking_level_select", level: "low", previousLevel: "medium" },
          { type: "thinking_level_select", level: "high", previousLevel: "low" },
        ]);
        expect((await loadTranscriptEvents(target)).slice(before.length)).toMatchObject([
          { type: "thinking_level_change", thinkingLevel: "low" },
          { type: "thinking_level_change", thinkingLevel: "high" },
        ]);
      }
    },
  );

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

  it("retains committed thinking metadata without adopting into the same locator under another storage root", async () => {
    const firstRoot = fs.realpathSync(tempDirs.make("metadata-commit-root-first-"));
    const secondRoot = fs.realpathSync(tempDirs.make("metadata-commit-root-second-"));
    const { session, sessionManager, settingsManager, target } = await createModelSession(
      undefined,
      undefined,
      undefined,
      { OPENCLAW_STATE_DIR: firstRoot },
    );
    await session.setModel(nextModel);
    const before = await loadTranscriptEvents(target);
    const replacement = { ...target, env: { OPENCLAW_STATE_DIR: secondRoot } };
    const original = metadataRuntime.withSessionMetadataWorker;
    const observeCommittedResult: typeof original = async (
      options,
      database,
      assertCurrent,
      operation,
    ) => {
      const result = await original(options, database, assertCurrent, operation);
      sessionManager.setSessionTarget(replacement);
      return result;
    };
    const observer = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation(observeCommittedResult);
    try {
      const failure: unknown = await session
        .setThinkingLevel("low")
        .catch((error: unknown) => error);
      expect(observer).toHaveBeenCalledOnce();
      expect(sessionManager.getSessionTarget()).toMatchObject(replacement);
      const after = await loadTranscriptEvents(target);
      const expectedEntry = { type: "thinking_level_change", thinkingLevel: "low" };
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toMatchObject([expectedEntry]);
      expect.soft(session.model?.id).toBe(nextModel.id);
      expect.soft(session.thinkingLevel).toBe("medium");
      expect.soft(settingsManager.getDefaultModel()).toBe(nextModel.id);
      expect.soft(settingsManager.getDefaultThinkingLevel()).toBe("medium");
      expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
      expect(failure).toMatchObject({
        committedEntry: expectedEntry,
        committedTarget: { ...target, env: { OPENCLAW_STATE_DIR: firstRoot } },
      });
      expect(hasModelFallbackStop(failure)).toBe(true);
      expect(() => sessionManager.getEntries()).toThrow(failure);
    } finally {
      observer.mockRestore();
    }
  });
});
