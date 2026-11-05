import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

const memoryIndex = await import("./index.js");
const projectKey = "github.com/example/project";
const projectOpts = { activeProjectKeys: [projectKey] };
const expectedCandidate = expect.objectContaining({
  projectKey,
  triggers: "release local",
  provenance: expect.objectContaining({ originClass: "agent" }),
});

describe("automatic candidates during provenance repair", () => {
  const { paths, provider, createConfig, getFreshManager, seedSessionTranscript } =
    createManagerIndexFixture(memoryIndex);
  type Config = Parameters<typeof getFreshManager>[0];
  async function seedLegacyIndex(cfg: Config, resetVersions = false) {
    await fs.writeFile(
      path.join(paths.workspace, "MEMORY.md"),
      `- Keep the release local. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
    );
    const initial = await getFreshManager(cfg, "cli");
    await initial.sync({ reason: "cli", force: true });
    const db = memoryIndexFixtureWriter(initial);
    db.exec("DELETE FROM memory_index_chunk_provenance");
    if (resetVersions) {
      db.exec(`DELETE FROM memory_embedding_cache;
        UPDATE memory_index_meta
        SET value = json_remove(value, '$.provenanceVersion', '$.chunkingVersion')
        WHERE key = 'memory_index_meta_v1'`);
    }
    await initial.close();
    if (resetVersions) {
      // Published vectors outlive the cache reset; new input makes the rebuild embed again.
      await fs.writeFile(
        path.join(paths.workspace, "MEMORY.md"),
        `- Keep every release local. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
      );
    }
  }
  const lookups = (manager: MemoryIndexManager) => [
    manager.listCuratedProjectCandidates(projectOpts),
    manager.listTriggerCandidates(projectOpts),
  ];

  it.for([false, true])(
    "returns before a pending rebuild finishes (startup catch-up: %s)",
    async (startupCatchup, { signal }) => {
      const cfg = createConfig({
        provider: "batch-wide-test",
        batchEnabled: true,
        vectorEnabled: false,
        sources: startupCatchup ? ["memory", "sessions"] : ["memory"],
        sessionMemory: startupCatchup,
      });
      if (startupCatchup) {
        await seedSessionTranscript({
          sessionId: "legacy-session",
          messages: [{ role: "user", timestamp: 1, content: "Remember the release preference." }],
        });
      }
      await seedLegacyIndex(cfg, true);

      const gate = createDeferred<void>();
      const batchEntered = createDeferred<void>();
      provider.providerRuntimeBatchGate = gate.promise;
      provider.providerRuntimeBatchEntered = () => batchEntered.resolve();
      // Native test cancellation must release both rendezvous before manager teardown.
      const abort = () => {
        batchEntered.resolve();
        gate.resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      let candidates: ReturnType<typeof lookups> = [];
      try {
        signal.throwIfAborted();
        if (startupCatchup) {
          vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
        }
        const upgraded = await getFreshManager(cfg);
        if (startupCatchup) {
          // Let real startup discovery finish before advancing its scheduled quiet period.
          await (upgraded as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
          await vi.advanceTimersByTimeAsync(30_000);
          await batchEntered.promise;
          vi.useRealTimers();
          signal.throwIfAborted();
        }
        candidates = lookups(upgraded);
        expect(await Promise.all(candidates)).toEqual([[], []]);
        await batchEntered.promise;
        signal.throwIfAborted();
        expect(provider.providerRuntimeActiveBatchCalls).toBe(1);
        expect(upgraded.status().dirty).toBe(true);
        gate.resolve();
        await upgraded.sync({ reason: "test-repair-complete" });
        expect(upgraded.status().dirty).toBe(false);
        expect(await Promise.all(lookups(upgraded))).toEqual([
          [expectedCandidate],
          [expectedCandidate],
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
        provider.providerRuntimeBatchEntered = null;
        gate.resolve();
        await Promise.allSettled(candidates);
      }
    },
  );

  it("drains admitted candidate repair retries before closing the database", async () => {
    const ftsConfig = createConfig({ provider: "none", vectorEnabled: false });
    await seedLegacyIndex(ftsConfig);

    const initialization = createDeferred<void>();
    const retryStarted = createDeferred<void>();
    const retry = createDeferred<void>();
    provider.providerInitGate = initialization.promise;
    provider.providerCreationFailure = "local";
    const upgraded = await getFreshManager(
      createConfig({ provider: "local", vectorEnabled: false }),
      "cli",
    );
    const owner = upgraded as unknown as {
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const runSync = owner.runSync.bind(upgraded);
    let pendingRetry: Promise<void> | undefined;
    const retryGate = vi
      .spyOn(owner, "runSync")
      .mockImplementation((params) => {
        retryStarted.resolve();
        pendingRetry = retry.promise.then(() => runSync(params));
        return pendingRetry;
      })
      .mockImplementationOnce(runSync);
    // Fail startup after fallback so candidate repair must admit a separate retry.
    const startupFailure = new Error("startup progress callback failed");
    const startupOutcome = upgraded
      .sync({
        reason: "session-startup-catchup",
        progress: () => {
          throw startupFailure;
        },
      })
      .catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    const closed = vi.fn();
    try {
      await vi.waitFor(() => expect(provider.providerCalls.at(-1)?.provider).toBe("local"));
      await expect(upgraded.listCuratedProjectCandidates(projectOpts)).resolves.toEqual([]);
      closing = upgraded.close().then(closed);
      // Enter close's drain before the running sync fails.
      await Promise.resolve();
      initialization.resolve();
      await retryStarted.promise;
      expect(await startupOutcome).toBe(startupFailure);
      expect(retryGate).toHaveBeenCalledTimes(2);
      // Give teardown a turn to finish while the admitted retry remains gated.
      await nextTurn();
      expect(closed).not.toHaveBeenCalled();
      retry.resolve();
      await closing;

      // The retry must persist, not merely be cancelled by close.
      const reopened = await getFreshManager(ftsConfig, "cli");
      expect(await reopened.listCuratedProjectCandidates(projectOpts)).toEqual([expectedCandidate]);
    } finally {
      initialization.resolve();
      retry.resolve();
      await startupOutcome.then(() => pendingRetry).catch(() => undefined);
      await closing;
      retryGate.mockRestore();
    }
  });
});
