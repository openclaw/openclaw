import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
} from "../dreaming-state.js";
import { forgetMemoryEntries } from "../memory-forget.js";
import { deleteShortTermLockEntryIfCurrent } from "../memory-workspace-lock.js";
import type { ShortTermLockEntry } from "../short-term-promotion-types.js";
import * as cpu from "./manager-cpu-worker-runtime.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("captured session preparation", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup(vectorEnabled = false) {
    await fixture.seedSessionTranscript({
      sessionId: "captured-session",
      messages: [
        { role: "user", timestamp: 1, content: "Violet Beta preference.", senderIsOwner: true },
      ],
    });
    const cfg = fixture.createConfig({
      provider: vectorEnabled ? "openai" : "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      vectorEnabled,
      cacheEnabled: true,
    });
    const manager = await fixture.getFreshManager(cfg);
    // SAFETY: this fixture owns the manager and inspects its published native store.
    const db = Reflect.get(manager, "db") as DatabaseSync;
    return { manager, db, cfg };
  }

  it("leaves the durable lease available while preparing captured session content", async () => {
    const { manager } = await setup();
    const store = openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    const key = memoryCoreWorkspaceStateKey(fixture.paths.workspace);
    const prepare = cpu.prepareMemoryIndexInWorker;
    const sessionClaims: boolean[] = [];
    const memoryClaims: boolean[] = [];
    vi.spyOn(cpu, "prepareMemoryIndexInWorker").mockImplementation(async (input) => {
      const entry = { owner: "independent-writer", acquiredAt: Date.now() };
      // The atomic store is the cross-process boundary; bypass only the local queue.
      const acquired = await store.registerIfAbsent(key, entry);
      (input.source === "sessions" ? sessionClaims : memoryClaims).push(acquired);
      if (acquired) {
        await deleteShortTermLockEntryIfCurrent(store, key, entry);
      }
      return prepare(input);
    });

    await manager.sync({ reason: "cli", force: true });

    expect(sessionClaims).toEqual([true]);
    expect(memoryClaims.length).toBeGreaterThan(0);
    expect(memoryClaims.every((claimed) => !claimed)).toBe(true);
    expect(await store.lookup(key)).toBeUndefined();
  });

  it.each([false, true])(
    "does not resurrect a session forgotten between preparation and writing (vectors: %s)",
    async (vectorEnabled) => {
      const { manager, db, cfg } = await setup(vectorEnabled);
      await manager.sync({ reason: "baseline", force: true });
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const prepare = cpu.prepareMemoryIndexInWorker;
      vi.spyOn(cpu, "prepareMemoryIndexInWorker").mockImplementation(async (input) => {
        const result = await prepare(input);
        if (input.source === "sessions") {
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
      const sync = manager.sync({ reason: "cli", force: true });
      void sync.catch(() => undefined);
      let forgotten: ReturnType<typeof forgetMemoryEntries> | undefined;
      try {
        await Promise.race([entered.promise, sync]);
        forgotten = forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["captured-session"] });
        void forgotten.catch(() => undefined);
        resume.resolve();
        await forgotten;
        const afterForget = db
          .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path")
          .all();
        await expect(sync).rejects.toThrow("forgotten");
        expect(
          db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all(),
        ).toEqual(afterForget);
        expect(
          db.prepare("SELECT path FROM memory_index_sources WHERE source='sessions'").all(),
        ).toEqual([]);
        expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
      } finally {
        resume.resolve();
        await Promise.allSettled([sync, forgotten]);
      }
    },
  );
});
