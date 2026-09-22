import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainStoreWriterQueuesForTest } from "../../shared/store-writer-queue.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWriteAdmission,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../../state/openclaw-agent-write-admission.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { ExtensionEvent, ThinkingLevelSelectEvent } from "./extensions/types.js";
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

  afterEach(() => {
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
    const fixture = await createTestSession({
      model: startModel,
      sessionManager: SessionManager.open(target, root),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultThinkingLevel: "medium",
      }),
      resourceLoader: createResourceLoader(handlers),
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
