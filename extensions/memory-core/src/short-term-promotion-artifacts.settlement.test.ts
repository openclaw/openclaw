import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { writeSessionIngestionState } from "./dreaming-ingestion-state.js";
import {
  configureMemoryCoreDreamingState,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SESSION_BACKFILL_REWIND_NAMESPACE,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
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

afterEach(async () => {
  vi.useRealTimers();
  await configureMemoryCoreDreamingStateForTests();
});

it.each([
  {
    operation: "grounded rollback",
    mutation: "delete",
    failingNamespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
    pendingNamespace: SHORT_TERM_RECALL_NAMESPACE,
    async prepare(workspaceDir: string) {
      await recordShortTermRecalls({
        workspaceDir,
        query: "historical candidate",
        signalType: "grounded",
        results: [
          {
            source: "memory",
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: "Keep a durable backup.",
            score: 0.9,
          },
        ],
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
    },
    run: (workspaceDir: string) => removeGroundedShortTermCandidates({ workspaceDir }),
  },
  {
    operation: "ingestion checkpoint",
    mutation: "register",
    failingNamespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
    pendingNamespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
    async prepare() {},
    run: (workspaceDir: string) =>
      withMemoryWorkspaceLock(workspaceDir, () =>
        writeSessionIngestionState(workspaceDir, {
          version: 3,
          files: {
            "main:session": {
              mtimeMs: 1,
              size: 1,
              contentHash: "snapshot",
              lineCount: 1,
              lastContentLine: 1,
            },
          },
          seenMessages: { "main:session": ["message-hash"] },
        }),
      ),
  },
  {
    operation: "rewind journal",
    mutation: "delete",
    failingNamespace: SESSION_BACKFILL_REWIND_NAMESPACE,
    pendingNamespace: SESSION_BACKFILL_REWIND_NAMESPACE,
    async prepare(workspaceDir: string) {
      for (const key of ["first-batch", "second-batch"]) {
        await writeMemoryCoreWorkspaceEntry({
          namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
          workspaceDir,
          key,
          value: { version: 1, candidates: [] },
        });
      }
    },
    run: (workspaceDir: string) =>
      withMemoryWorkspaceLock(workspaceDir, () =>
        rewindSessionBackfillIngestionState({ workspaceDir, agentId: "main" }),
      ),
  },
] as const)(
  "settles $operation writes before releasing the workspace to another writer",
  async (scenario) => {
    const workspaceDir = await createTempWorkspace("write-settlement-");
    await scenario.prepare(workspaceDir);
    const siblingEntered = createDeferred<void>();
    const releaseSibling = createDeferred<void>();
    const firstFailureIssued = createDeferred<void>();
    const failure = new Error("write unavailable");
    let failureSelected = false;
    let lockReleaseStarted = false;
    const beforeMutation = async (namespace: string) => {
      if (namespace === scenario.failingNamespace && !failureSelected) {
        failureSelected = true;
        await siblingEntered.promise;
        firstFailureIssued.resolve();
        throw failure;
      }
      if (namespace === scenario.pendingNamespace) {
        siblingEntered.resolve();
        await releaseSibling.promise;
        throw new Error("later sibling failure");
      }
    };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>("memory-core", options);
      return {
        ...store,
        async compareAndApply(...args: Parameters<typeof store.compareAndApply>) {
          if (options.namespace === SHORT_TERM_LOCK_NAMESPACE && args[2].operation === "delete") {
            lockReleaseStarted = true;
          }
          return await store.compareAndApply(...args);
        },
        async register(...args: Parameters<typeof store.register>) {
          if (scenario.mutation === "register") {
            await beforeMutation(options.namespace);
          }
          return await store.register(...args);
        },
        async delete(key: string) {
          if (scenario.mutation === "delete") {
            await beforeMutation(options.namespace);
          }
          return await store.delete(key);
        },
      };
    });
    let rollbackSettled = false;
    const rollback = scenario.run(workspaceDir).catch((error: unknown) => {
      rollbackSettled = true;
      return error;
    });
    await firstFailureIssued.promise;
    let nextWriterEntered = false;
    const nextWriter = withMemoryWorkspaceLock(workspaceDir, async () => {
      nextWriterEntered = true;
    });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(lockReleaseStarted).toBe(false);
      expect(rollbackSettled).toBe(false);
      expect(nextWriterEntered).toBe(false);
    } finally {
      releaseSibling.resolve();
      vi.useRealTimers();
      await Promise.allSettled([rollback, nextWriter]);
    }
    expect(await rollback).toBe(failure);
    expect(nextWriterEntered).toBe(true);
  },
);
