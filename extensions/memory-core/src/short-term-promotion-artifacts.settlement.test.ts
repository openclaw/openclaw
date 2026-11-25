import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { writeSessionIngestionState } from "./dreaming-ingestion-state.js";
import {
  configureMemoryCoreDreamingState,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE as FILES,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE as SEEN,
  SESSION_BACKFILL_REWIND_NAMESPACE as REWIND,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE as PHASE,
  SHORT_TERM_RECALL_NAMESPACE as RECALL,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { recallResult } from "./recall-result.test-support.js";
import { rewindSessionBackfillIngestionState } from "./session-backfill-lifecycle.js";
import { removeGroundedShortTermCandidates } from "./short-term-promotion-artifacts.js";
import { recordShortTermRecalls } from "./short-term-promotion-record.js";
import { recordDreamingPhaseSignals } from "./short-term-promotion-stats.js";
import {
  configureMemoryCoreDreamingStateForTests,
  createMemoryCoreTestHarness,
  shortTermTestState,
} from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => configureMemoryCoreDreamingStateForTests());

it.each([
  ["grounded rollback", "delete", PHASE, RECALL],
  ["ingestion checkpoint", "register", FILES, SEEN],
  ["rewind journal", "delete", REWIND, REWIND],
] as const)(
  "settles %s writes before releasing the workspace",
  async (operation, mutation, failingNamespace, pendingNamespace) => {
    const workspaceDir = await createTempWorkspace("write-settlement-");
    const snapshot = { mtimeMs: 1, size: 1, contentHash: "x", lineCount: 1, lastContentLine: 1 };
    if (operation === "grounded rollback") {
      await recordShortTermRecalls({
        workspaceDir,
        query: "historical candidate",
        signalType: "grounded",
        results: [recallResult],
      });
      const recall = await shortTermTestState.readRecallStore(
        workspaceDir,
        new Date().toISOString(),
      );
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "light",
        keys: Object.keys(recall.entries),
      });
    } else if (operation === "rewind journal") {
      for (const key of ["first-batch", "second-batch"]) {
        await writeMemoryCoreWorkspaceEntry({
          namespace: REWIND,
          workspaceDir,
          key,
          value: { version: 1, candidates: [] },
        });
      }
    }
    const run = () =>
      operation === "grounded rollback"
        ? removeGroundedShortTermCandidates({ workspaceDir })
        : withMemoryWorkspaceLock(workspaceDir, async () => {
            await (operation === "rewind journal"
              ? rewindSessionBackfillIngestionState({ workspaceDir, agentId: "main" })
              : writeSessionIngestionState(workspaceDir, {
                  version: 3,
                  files: { "main:session": snapshot },
                  seenMessages: { "main:session": ["message-hash"] },
                }));
          });
    const siblingEntered = createDeferred<void>();
    const releaseSibling = createDeferred<void>();
    const firstFailureIssued = createDeferred<void>();
    const failure = new Error("write unavailable");
    let failureSelected = false;
    const beforeMutation = async (namespace: string) => {
      if (namespace === failingNamespace && !failureSelected) {
        failureSelected = true;
        await siblingEntered.promise;
        firstFailureIssued.resolve();
        throw failure;
      }
      if (namespace === pendingNamespace) {
        siblingEntered.resolve();
        await releaseSibling.promise;
        throw new Error("later sibling failure");
      }
    };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>("memory-core", options);
      const intercept =
        <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
        async (...args: A) => {
          await beforeMutation(options.namespace);
          return await fn(...args);
        };
      return {
        ...store,
        register: mutation === "register" ? intercept(store.register.bind(store)) : store.register,
        delete: mutation === "delete" ? intercept(store.delete.bind(store)) : store.delete,
      };
    });
    const settled = vi.fn();
    const rollback = run()
      .finally(settled)
      .catch((error: unknown) => error);
    await firstFailureIssued.promise;
    const nextWriterEntered = vi.fn(async () => {});
    const nextWriter = withMemoryWorkspaceLock(workspaceDir, nextWriterEntered);
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([settled.mock.calls.length, nextWriterEntered.mock.calls.length]).toEqual([0, 0]);
    } finally {
      releaseSibling.resolve();
      vi.useRealTimers();
      await Promise.allSettled([rollback, nextWriter]);
    }
    expect(await rollback).toBe(failure);
    expect(nextWriterEntered).toHaveBeenCalledExactlyOnceWith();
  },
);
