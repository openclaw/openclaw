import { realpathSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { compactionSettings, sessionTarget } from "./agent-session-boundary.test-support.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { ExtensionEvent } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});
registerAgentSessionLoopTestLifecycle();

type BeforeCompactionEvent = Extract<ExtensionEvent, { type: "session_before_compact" }>;

it("does not append when a compaction extension rejects the finalized summary", async () => {
  const dir = tempDirs.make("openclaw-rejected-compaction-");
  const target = sessionTarget(path.join(dir, "sessions.json"), "rejected-compaction-reopen");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(target, {
    cwd: dir,
    message: { role: "user", content: "authoritative question", timestamp: 1 },
  });
  const sessionManager = SessionManager.open(target, dir);
  sessionManager.appendMessage(createAssistant(testModel, "authoritative answer"));
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
    ["session_before_compact", [async () => ({ cancel: true })]],
  ]);
  const { session } = await createTestSession({
    sessionManager,
    resourceLoader: createResourceLoader(handlers),
  });
  const persistedBefore = await loadTranscriptEvents(target);
  const contextBefore = sessionManager.buildSessionContext();

  await expect(session.compact()).rejects.toThrow("Compaction cancelled");

  sessionManager.flushPendingPersistence();
  const persistedAfterRejection = await loadTranscriptEvents(target);
  expect(persistedAfterRejection).toEqual(persistedBefore);

  const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
  expect(await closeOpenClawAgentDatabaseByPathAsync(databasePath)).toBe(true);
  const reopened = SessionManager.open(target, dir);
  expect(reopened.getBranch()).toEqual(persistedBefore.slice(1));
  expect(reopened.buildSessionContext()).toEqual(contextBefore);
});

it("does not publish a cancelled compaction while waiting for the writer", async () => {
  const root = realpathSync(tempDirs.make("openclaw-context-admission-"));
  const target = sessionTarget(path.join(root, "sessions.json"), "context-admission");
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(target, root);
  manager.appendMessage(makeUserMessage("old prompt", 1));
  manager.appendMessage(createAssistant(testModel, "old answer"));
  manager.appendMessage(makeUserMessage("recent prompt", 3));
  manager.appendMessage(createAssistant(testModel, "recent answer"));
  const summaryReady = createDeferred();
  const published: string[] = [];
  const beforeCompact = async (event: unknown) => {
    summaryReady.resolve();
    const { firstKeptEntryId, tokensBefore } = (event as BeforeCompactionEvent).preparation;
    return { compaction: { summary: "condensed history", firstKeptEntryId, tokensBefore } };
  };
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
    ["session_before_compact", [beforeCompact]],
    [
      "session_compact",
      [
        async () => {
          published.push("compaction");
        },
      ],
    ],
  ]);
  const { session } = await createTestSession({
    sessionManager: manager,
    settingsManager: compactionSettings(),
    resourceLoader: createResourceLoader(handlers),
  });
  const before = await loadTranscriptEvents(target);
  const messagesBefore = [...session.messages];
  const release = createDeferred();
  const entered = createDeferred();
  const reservation = runOpenClawAgentWriteAdmission(
    toDatabaseOptions(resolveSqliteReadScope(target)),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  const work = session.compact();
  const outcome = work.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  try {
    await summaryReady.promise;
    // The summary continuations reach the held writer before cancellation.
    await nextTurn();
    session.abortCompaction();
    release.resolve();
    const result = await outcome;
    expect(result).toMatchObject({
      status: "rejected",
      error: new Error("Compaction cancelled"),
    });
    expect(await loadTranscriptEvents(target)).toEqual(before);
    expect(session.messages).toEqual(messagesBefore);
    expect(published).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([reservation, work]);
  }
});
