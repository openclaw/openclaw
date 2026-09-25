import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { runMemoryIndexState } from "./manager-cpu-worker-runtime.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("automatic candidates during provenance repair", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.for([false, true])(
    "returns before a pending rebuild finishes (startup catch-up: %s)",
    async (startupCatchup, { signal }) => {
      const projectKey = "github.com/example/project";
      await fs.writeFile(
        path.join(fixture.paths.workspace, "MEMORY.md"),
        `- Keep the release local. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
      );
      await Promise.all(
        Array.from({ length: 256 }, (_, index) =>
          fs.writeFile(
            path.join(fixture.paths.memory, `entry-${index}.md`),
            `# Entry ${index}\nSynthetic memory content ${index}.\n`,
          ),
        ),
      );
      const cfg = fixture.createConfig({
        provider: "batch-wide-test",
        batchEnabled: true,
        vectorEnabled: false,
        sources: startupCatchup ? ["memory", "sessions"] : ["memory"],
        sessionMemory: startupCatchup,
      });
      if (startupCatchup) {
        await fixture.seedSessionTranscript({
          sessionId: "legacy-session",
          messages: [{ role: "user", timestamp: 1, content: "Remember the release preference." }],
        });
      }
      const initial = await fixture.getFreshManager(cfg, "cli");
      await initial.sync({ reason: "cli", force: true });
      const db = Reflect.get(initial, "db") as DatabaseSync;
      // Older indexes have neither classified provenance nor a chunking version.
      db.exec("DELETE FROM memory_index_chunk_provenance; DELETE FROM memory_embedding_cache");
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get() as { value: string };
      const meta = JSON.parse(row.value) as MemoryIndexMeta;
      delete meta.provenanceVersion;
      delete meta.chunkingVersion;
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify(meta),
      );
      await initial.close();

      const gate = createDeferred<void>();
      const batchEntered = createDeferred<void>();
      fixture.provider.providerRuntimeBatchGate = gate.promise;
      fixture.provider.providerRuntimeBatchEntered = () => batchEntered.resolve();
      // Native test cancellation must release both rendezvous before manager teardown.
      const abort = () => {
        batchEntered.resolve();
        gate.resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      const candidates: Promise<unknown>[] = [];
      try {
        signal.throwIfAborted();
        const upgraded = await fixture.getFreshManager(cfg);
        expect(upgraded.status().custom?.indexIdentity).toMatchObject({
          status: "mismatched",
          reason: "index provenance classifier changed",
        });
        if (startupCatchup) {
          await batchEntered.promise;
          signal.throwIfAborted();
          expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1);
        }
        let completed = 0;
        for (const lookup of [
          () => upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
          () => upgraded.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
        ]) {
          candidates.push(
            lookup().then((results) => {
              completed += 1;
              return results;
            }),
          );
        }
        // Queue a read behind both lookups on the single retrieval worker. Their
        // public promises must then settle without releasing the repair gate.
        await runMemoryIndexState({
          agentId: "main",
          databasePath: expectDefined(upgraded.status().dbPath, "memory database path"),
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(2);
        expect(await Promise.all(candidates)).toEqual([[], []]);
        await batchEntered.promise;
        signal.throwIfAborted();
        expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1);
        expect(upgraded.status().dirty).toBe(true);
        gate.resolve();
        await upgraded.sync({ reason: "test-repair-complete" });
        expect(upgraded.status().dirty).toBe(false);
        const expected = [
          expect.objectContaining({
            projectKey,
            triggers: "release local",
            provenance: expect.objectContaining({ originClass: "agent" }),
          }),
        ];
        expect(
          await upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
        ).toEqual(expected);
        expect(await upgraded.listTriggerCandidates({ activeProjectKeys: [projectKey] })).toEqual(
          expected,
        );
      } finally {
        signal.removeEventListener("abort", abort);
        fixture.provider.providerRuntimeBatchEntered = null;
        gate.resolve();
        await Promise.allSettled(candidates);
      }
    },
  );

  it("drains admitted candidate repair retries before closing the database", async () => {
    const projectKey = "github.com/example/project";
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      `- Preserve the release preference. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
    );
    const ftsConfig = fixture.createConfig({ provider: "none", vectorEnabled: false });
    const initial = await fixture.getFreshManager(ftsConfig, "cli");
    await initial.sync({ reason: "cli", force: true });
    // The existing migration will invalidate these sources on the next open.
    const initialDb = Reflect.get(initial, "db") as DatabaseSync;
    initialDb.exec("DELETE FROM memory_index_chunk_provenance");
    await initial.close();

    const initialization = createDeferred<void>();
    const retryStarted = createDeferred<void>();
    const retry = createDeferred<void>();
    fixture.provider.providerInitGate = initialization.promise;
    fixture.provider.providerCreationFailure = "local";
    const upgraded = await fixture.getFreshManager(
      fixture.createConfig({ provider: "local", vectorEnabled: false }),
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
    // This is the same public sync admission used by detached startup catch-up.
    // Optional initialization now falls back successfully. Fail its first real
    // keyword generation so candidate repair must still admit a separate retry.
    const startupFailure = new Error("startup progress callback failed");
    const startup = upgraded.sync({
      reason: "session-startup-catchup",
      progress: () => {
        throw startupFailure;
      },
    });
    const startupOutcome = startup.then(
      () => undefined,
      (error: unknown) => error,
    );
    let closing: Promise<void> | undefined;
    let closeSettled = false;
    try {
      await vi.waitFor(() => expect(fixture.provider.providerCalls.at(-1)?.provider).toBe("local"));
      await expect(
        upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).resolves.toEqual([]);
      closing = upgraded.close().then(() => {
        closeSettled = true;
      });
      // Let close enter its drain before the already-running sync fails. This
      // reproduces the original execution order without a timing-based sleep.
      await Promise.resolve();
      initialization.resolve();
      await retryStarted.promise;
      expect(await startupOutcome).toBe(startupFailure);
      expect(retryGate).toHaveBeenCalledTimes(2);
      // Give teardown a turn to finish while the admitted retry remains gated.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeSettled).toBe(false);
      retry.resolve();
      await closing;

      // Observable persistence proof: close did not merely cancel or abandon
      // the retry; its classified candidates survive a fresh manager open.
      const reopened = await fixture.getFreshManager(ftsConfig, "cli");
      expect(
        await reopened.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).toEqual([
        expect.objectContaining({
          projectKey,
          triggers: "release local",
          provenance: expect.objectContaining({ originClass: "agent" }),
        }),
      ]);
    } finally {
      initialization.resolve();
      retry.resolve();
      await startupOutcome;
      await pendingRetry?.catch(() => undefined);
      await closing;
      await upgraded.close();
      retryGate.mockRestore();
    }
  });

  it("withholds legacy curated candidates until background provenance repair succeeds", async () => {
    const projectKey = "github.com/openclaw/openclaw";
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      `- Preserve legacy preference. <!-- trigger: legacy preference --> <!-- project: ${projectKey} -->\n`,
    );
    const cfg = fixture.createConfig({ provider: "none" });
    const initialManager = await fixture.getFreshManager(cfg);
    await initialManager.sync({ reason: "test", force: true });
    const initialDb = Reflect.get(initialManager, "db") as DatabaseSync;
    initialDb.exec(`DELETE FROM ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}`);
    await initialManager.close();

    const upgradedManager = await fixture.getFreshManager(cfg);
    try {
      expect(upgradedManager.status().dirty).toBe(true);
      const upgradedDb = Reflect.get(upgradedManager, "db") as DatabaseSync;
      expect(
        upgradedDb
          .prepare(
            `SELECT hash FROM memory_index_sources WHERE path = 'MEMORY.md' AND source = 'memory'`,
          )
          .get(),
      ).toEqual({ hash: "" });
      expect(
        upgradedDb
          .prepare(
            `SELECT DISTINCT origin_class AS originClass
             FROM ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}`,
          )
          .all(),
      ).toEqual([{ originClass: "untrusted" }]);
      if (!upgradedManager.listCuratedProjectCandidates || !upgradedManager.listTriggerCandidates) {
        throw new Error("expected curated project and trigger candidate listing");
      }
      const syncAdmitted = vi
        .spyOn(
          upgradedManager as unknown as {
            syncAdmitted: (
              params?: MemorySyncParams,
              options?: { allowEmbeddingBootstrapFallback?: boolean },
            ) => Promise<void>;
          },
          "syncAdmitted",
        )
        .mockRejectedValueOnce(new Error("legacy provenance repair unavailable"));
      await expect(
        upgradedManager.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).resolves.toEqual([]);
      expect(syncAdmitted).toHaveBeenCalledWith(
        { reason: "search" },
        { allowEmbeddingBootstrapFallback: true },
      );
      expect(upgradedManager.status().dirty).toBe(true);
      syncAdmitted.mockRestore();

      const repairGate = createDeferred<void>();
      // SAFETY: the test controls the manager's internal sync to keep provenance repair pending.
      const owner = upgradedManager as unknown as {
        runSync: (params?: MemorySyncParams) => Promise<void>;
      };
      const actualRunSync = owner.runSync.bind(upgradedManager);
      const runSync = vi.spyOn(owner, "runSync").mockImplementation(async (params) => {
        await repairGate.promise;
        return await actualRunSync(params);
      });
      try {
        await expect(
          Promise.all([
            upgradedManager.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
            upgradedManager.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
          ]),
        ).resolves.toEqual([[], []]);
      } finally {
        repairGate.resolve();
      }
      await upgradedManager.sync({ reason: "test-repair-complete" });
      const [projectCandidates, triggerCandidates] = await Promise.all([
        upgradedManager.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
        upgradedManager.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
      ]);
      expect(projectCandidates).toMatchObject([
        {
          projectKey,
          triggers: "legacy preference",
          provenance: { originClass: "agent" },
        },
      ]);
      expect(triggerCandidates).toMatchObject([
        {
          projectKey,
          triggers: "legacy preference",
          provenance: { originClass: "agent" },
        },
      ]);
      expect(runSync).toHaveBeenCalledTimes(1);
      expect(upgradedManager.status().dirty).toBe(false);
      expect(
        upgradedDb
          .prepare(
            `SELECT hash FROM memory_index_sources WHERE path = 'MEMORY.md' AND source = 'memory'`,
          )
          .get(),
      ).toMatchObject({ hash: expect.not.stringMatching(/^$/u) });
    } finally {
      await upgradedManager.close();
    }
  });
});
