import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetMemoryEntries } from "../memory-forget.js";
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
