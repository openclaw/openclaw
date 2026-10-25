import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import type { MemoryFileWatcher } from "./file-watcher.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import { openObservedManager } from "./manager-observation.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

// Keep owner fault injection in this process; real worker transport has separate coverage.
vi.mock("./local-file-watcher.js", async (original) => {
  const watcher = await import("./file-watcher.js");
  return {
    ...(await original<typeof import("./local-file-watcher.js")>()),
    LocalMemoryFileWatcher: watcher.MemoryFileWatcher,
  };
});

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
const embedding = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  embed: vi.fn<() => Promise<number[]>>(),
  embedBatch: vi.fn<(inputs: EmbeddingInput[]) => Promise<number[][]>>(),
}));
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));
vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => ({
    provider: { id: "openai", model: "close-test" },
  }),
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: { id: "openai", model: "close-test", ...embedding },
  }),
}));

type CloseFields = {
  closed: boolean;
  fileWatcher: MemoryFileWatcher;
  publishedDatabase: MemoryIndexDatabase;
  sessionUnsubscribe: (() => void) | null;
  awaitManagerIdle: () => Promise<void>;
};
const observerFailure = new Error("observer retirement failed");
const calls = (...spies: { mock: { calls: unknown[] } }[]) =>
  spies.map((spy) => spy.mock.calls.length);

describe("MemoryIndexManager observation close lifecycle", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  const managers: MemoryIndexManager[] = [];
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "memory-manager-observation-close" });
    await configureMemoryCoreDreamingStateForTests();
    await fs.mkdir(path.join(state.workspaceDir, "memory"));
    await fs.writeFile(path.join(state.workspaceDir, "memory", "note.md"), "Alpha memory.");
  });
  beforeEach(() => {
    observer.reset();
    embedding.close.mockReset().mockResolvedValue(undefined);
    embedding.embed.mockReset().mockResolvedValue([1, 0]);
    embedding.embedBatch.mockReset().mockImplementation(async (inputs) => inputs.map(() => [1, 0]));
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    // Sticky physical failures keep these managers owned by the isolated process.
    await Promise.allSettled(managers.map((manager) => manager.close()));
    resetMemoryCoreDreamingStateForTests();
    await state.cleanup();
  });

  async function open(beforeWorkerClose: (fields: CloseFields) => void | Promise<void>) {
    const agentId = `observation-close-${managers.length}`;
    const { manager } = await openObservedManager(
      state.workspaceDir,
      {
        provider: "openai",
        model: "close-test",
        fallback: "none",
        sources: ["memory", "sessions"],
        rememberAcrossConversations: true,
      },
      agentId,
    );
    managers.push(manager);
    const fields = manager as unknown as CloseFields;
    await fields.awaitManagerIdle();
    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    expect(observer.observations).toHaveLength(1);
    expect(fields.sessionUnsubscribe).toBeTypeOf("function");
    const entry = observer.observations[0]!;
    entry.close.mockRejectedValue(observerFailure);
    const db = fields.publishedDatabase;
    const release = vi.spyOn(db, "release");
    const closeWorker = db.closePublicationWorker.bind(db);
    const worker = vi.spyOn(db, "closePublicationWorker").mockImplementation(async () => {
      await beforeWorkerClose(fields);
      await closeWorker();
    });
    return { manager, fields, entry, release, worker };
  }

  it.each([false, true])(
    "drains independent resources after observer close rejection (provider failure: %s)",
    async (failProvider) => {
      const workerEntered = createDeferred<void>();
      const workerGate = createDeferred<void>();
      const { manager, fields, entry, release, worker } = await open(async () => {
        workerEntered.resolve();
        await workerGate.promise;
      });
      const providerFailure = new Error("provider retirement failed");
      if (failProvider) {
        embedding.close.mockRejectedValueOnce(providerFailure);
      }
      const unsubscribe = vi.fn(fields.sessionUnsubscribe!);
      fields.sessionUnsubscribe = unsubscribe;
      const closing = manager.close();
      const concurrent = manager.close();
      const outcomes = Promise.allSettled([closing, concurrent]);
      try {
        // A pre-fix rejection wakes the wait instead of hanging on unreachable cleanup.
        await Promise.race([workerEntered.promise, outcomes]);
        expect(fields.sessionUnsubscribe).toBeNull();
        expect(calls(unsubscribe, embedding.close, worker, release)).toEqual([1, 1, 1, 0]);
        expect(fields.publishedDatabase.db.isOpen).toBe(true);
        workerGate.resolve();
        const results = await outcomes;
        const watcherError = await fields.fileWatcher.close().catch((error: unknown) => error);
        expect(watcherError).toMatchObject({ errors: [observerFailure] });
        const expectedError = failProvider
          ? expect.objectContaining({ errors: [watcherError, providerFailure] })
          : watcherError;
        expect(results).toEqual(
          Array.from({ length: 2 }, () => ({ status: "rejected", reason: expectedError })),
        );
        expect(release).toHaveBeenCalledOnce();

        // Retrying the provider cannot erase the observer failure.
        await expect(manager.close()).rejects.toBe(watcherError);
        await expect(manager.close()).rejects.toBe(watcherError);
        expect(calls(embedding.close, entry.close, worker, release)).toEqual([
          failProvider ? 2 : 1,
          1,
          1,
          1,
        ]);
      } finally {
        workerGate.resolve();
        await outcomes;
      }
    },
  );

  it("joins accepted sync work and retains the database lease until its worker closes", async () => {
    const workerFailure = new Error("publication worker join failed");
    let failWorker = true;
    const { manager, fields, entry, release } = await open((closingFields) => {
      // Fail the final join, not the accepted sync's own publication cleanup.
      if (closingFields.closed && failWorker) {
        failWorker = false;
        throw workerFailure;
      }
    });
    const embeddingEntered = createDeferred<void>();
    const embeddingGate = createDeferred<void>();
    embedding.embedBatch.mockClear().mockImplementation(async (inputs) => {
      embeddingEntered.resolve();
      await embeddingGate.promise;
      return inputs.map(() => [1, 0]);
    });
    const syncing = manager.sync({ reason: "test", force: true });
    let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await Promise.race([embeddingEntered.promise, syncing]);
      expect(embedding.embedBatch).toHaveBeenCalled();
      const closing = manager.close();
      outcomes = Promise.allSettled([closing]);
      expect(fields.closed).toBe(false);
      expect(calls(release, entry.close, embedding.close)).toEqual([0, 0, 0]);
      embeddingGate.resolve();
      await syncing;
      const results = await outcomes;
      const watcherError = await fields.fileWatcher.close().catch((error: unknown) => error);
      expect(results).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ errors: [watcherError, workerFailure] }),
        },
      ]);
      expect(watcherError).toMatchObject({ errors: [observerFailure] });
      expect(release).not.toHaveBeenCalled();
      expect(fields.publishedDatabase.db.isOpen).toBe(true);
      await expect(manager.close()).rejects.toBe(watcherError);
      expect(calls(release, embedding.close, entry.close)).toEqual([1, 1, 1]);
    } finally {
      embeddingGate.resolve();
      await Promise.allSettled([syncing]);
      await outcomes;
    }
  });
});
