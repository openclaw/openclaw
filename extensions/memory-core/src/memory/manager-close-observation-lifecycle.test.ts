import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import type { MemoryFileWatcher } from "./file-watcher.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemoryIndexManager } from "./manager.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
const embedding = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  embed: vi.fn<() => Promise<number[]>>(),
  embedBatch: vi.fn<(inputs: EmbeddingInput[]) => Promise<number[][]>>(),
}));
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watch }));
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
    // These boundary-injected physical failures are intentionally sticky. The
    // file owns its managers until this isolated test process ends.
    await Promise.allSettled(managers.map((manager) => manager.close()));
    resetMemoryCoreDreamingStateForTests();
    await state.cleanup();
  });

  async function open(agentId: string) {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: agentId }] },
      memory: {
        search: {
          provider: "openai",
          model: "close-test",
          fallback: "none",
          sources: ["memory", "sessions"],
          rememberAcrossConversations: true,
          store: { vector: { enabled: false } },
        },
      },
    };
    const manager = await MemoryIndexManager.get({ cfg, agentId });
    if (!manager) {
      throw new Error("Expected a persistent Memory manager");
    }
    managers.push(manager);
    const fields = manager as unknown as CloseFields;
    await fields.awaitManagerIdle();
    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    expect(observer.observations).toHaveLength(1);
    expect(fields.sessionUnsubscribe).toBeTypeOf("function");
    return { manager, fields, entry: observer.observations[0]! };
  }

  it.each([false, true])(
    "drains independent resources after observer close rejection (provider retry: %s)",
    async (failProvider) => {
      const { manager, fields, entry } = await open("observation-close-" + failProvider);
      const physicalFailure = new Error("observer retirement failed");
      entry.close.mockRejectedValue(physicalFailure);
      const providerFailure = new Error("provider retirement failed");
      if (failProvider) {
        embedding.close
          .mockRejectedValueOnce(providerFailure)
          .mockRejectedValueOnce(providerFailure);
      }
      const unsubscribe = vi.fn(fields.sessionUnsubscribe!);
      fields.sessionUnsubscribe = unsubscribe;
      const release = vi.spyOn(fields.publishedDatabase, "release");
      const workerEntered = createDeferred<void>();
      const workerGate = createDeferred<void>();
      const closeWorker = fields.publishedDatabase.closePublicationWorker.bind(
        fields.publishedDatabase,
      );
      const workerClose = vi
        .spyOn(fields.publishedDatabase, "closePublicationWorker")
        .mockImplementation(async () => {
          workerEntered.resolve();
          await workerGate.promise;
          await closeWorker();
        });
      const closing = manager.close();
      const concurrent = manager.close();
      const outcomes = Promise.allSettled([closing, concurrent]);
      try {
        // A pre-fix rejection also wakes this wait, so the resource assertions
        // fail directly instead of timing out waiting for unreachable cleanup.
        await Promise.race([workerEntered.promise, outcomes]);
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(fields.sessionUnsubscribe).toBeNull();
        expect(embedding.close).toHaveBeenCalledTimes(failProvider ? 2 : 1);
        expect(workerClose).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        expect(fields.publishedDatabase.db.isOpen).toBe(true);
        workerGate.resolve();
        const results = await outcomes;
        const watcherError = await fields.fileWatcher.close().catch((error: unknown) => error);
        expect(watcherError).toMatchObject({ errors: [physicalFailure] });
        const expectedError = failProvider
          ? expect.objectContaining({ errors: [watcherError, providerFailure] })
          : watcherError;
        expect(results).toEqual([
          { status: "rejected", reason: expectedError },
          { status: "rejected", reason: expectedError },
        ]);
        expect(release).toHaveBeenCalledOnce();

        // Provider retirement remains retryable, but cannot erase the actual
        // observation failure.
        await expect(manager.close()).rejects.toBe(watcherError);
        await expect(manager.close()).rejects.toBe(watcherError);
        expect(embedding.close).toHaveBeenCalledTimes(failProvider ? 3 : 1);
        expect(entry.close).toHaveBeenCalledOnce();
        expect(workerClose).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        entry.dirty();
        expect(observer.watch).toHaveBeenCalledOnce();
      } finally {
        workerGate.resolve();
        await outcomes;
      }
    },
  );

  it("allows a provider-only retirement failure to succeed on repeated close", async () => {
    const { manager, fields, entry } = await open("provider-only-close");
    const failure = new Error("provider retirement failed");
    embedding.close.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const release = vi.spyOn(fields.publishedDatabase, "release");
    const workerClose = vi.spyOn(fields.publishedDatabase, "closePublicationWorker");
    await expect(manager.close()).rejects.toBe(failure);
    expect(embedding.close).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    await expect(manager.close()).resolves.toBeUndefined();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(embedding.close).toHaveBeenCalledTimes(3);
    expect(entry.close).toHaveBeenCalledOnce();
    expect(workerClose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("joins accepted sync work and retains the database lease until its worker closes", async () => {
    const { manager, fields, entry } = await open("sync-observation-close");
    const physicalFailure = new Error("observer retirement failed");
    entry.close.mockRejectedValue(physicalFailure);
    const embeddingEntered = createDeferred<void>();
    const embeddingGate = createDeferred<void>();
    embedding.embedBatch.mockClear().mockImplementation(async (inputs) => {
      embeddingEntered.resolve();
      await embeddingGate.promise;
      return inputs.map(() => [1, 0]);
    });
    const release = vi.spyOn(fields.publishedDatabase, "release");
    const workerFailure = new Error("publication worker join failed");
    const closeWorker = fields.publishedDatabase.closePublicationWorker.bind(
      fields.publishedDatabase,
    );
    let failWorker = true;
    vi.spyOn(fields.publishedDatabase, "closePublicationWorker").mockImplementation(async () => {
      // Allow the accepted sync's own publication cleanup, then reject the
      // manager's final worker join. A failed join must retain the database lease.
      if (fields.closed && failWorker) {
        failWorker = false;
        throw workerFailure;
      }
      await closeWorker();
    });
    const syncing = manager.sync({ reason: "test", force: true });
    let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await Promise.race([embeddingEntered.promise, syncing]);
      expect(embedding.embedBatch).toHaveBeenCalled();
      const closing = manager.close();
      outcomes = Promise.allSettled([closing]);
      expect(fields.closed).toBe(false);
      expect(release).not.toHaveBeenCalled();
      expect(entry.close).not.toHaveBeenCalled();
      expect(embedding.close).not.toHaveBeenCalled();
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
      expect(watcherError).toMatchObject({ errors: [physicalFailure] });
      expect(release).not.toHaveBeenCalled();
      expect(fields.publishedDatabase.db.isOpen).toBe(true);
      await expect(manager.close()).rejects.toBe(watcherError);
      expect(release).toHaveBeenCalledOnce();
      expect(embedding.close).toHaveBeenCalledOnce();
      expect(entry.close).toHaveBeenCalledOnce();
    } finally {
      embeddingGate.resolve();
      await Promise.allSettled([syncing]);
      await outcomes;
    }
  });
});
