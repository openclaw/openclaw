import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watch }));

describe("Memory capacity refresh-on-search", () => {
  it.each(["EMFILE", "ENFILE", "ENOSPC"])(
    "keeps later searches fresh after watch-side %s",
    async (code) => {
      observer.reset();
      const state = await createOpenClawTestState({ label: "memory-watch-capacity" });
      let manager: MemoryIndexManager | null = null;
      try {
        await configureMemoryCoreDreamingStateForTests(state.env);
        const memoryDir = path.join(state.workspaceDir, "memory");
        await fs.mkdir(memoryDir);
        await fs.writeFile(path.join(memoryDir, "baseline.md"), "Amber lantern baseline.");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
          memory: {
            search: {
              provider: "none",
              sources: ["memory"],
              store: { vector: { enabled: false } },
              query: { minScore: 0 },
            },
          },
        };
        manager = await MemoryIndexManager.get({ cfg, agentId: "main" });
        if (!manager) {
          throw new Error("memory manager unavailable");
        }
        const activeManager = manager;
        await activeManager.sync({ reason: "test-initial-index" });
        expect(observer.observations.length).toBeGreaterThan(0);
        observer.observations[0]!.health({
          state: "unavailable",
          error: new Error(code),
          failure: { operation: "watch", code },
        });
        // No further observation is emitted: every subsequent fresh result must
        // come through the manager's degraded search boundary and real indexer.
        for (const text of ["Cobalt heron discovered.", "Violet badger replaced it."]) {
          await fs.writeFile(path.join(memoryDir, "fresh.md"), text);
          await expect
            .poll(async () => (await activeManager.search(text)).map((result) => result.snippet), {
              timeout: 10_000,
            })
            .toContain(text);
        }
        expect(await activeManager.search("Cobalt heron")).toEqual([]);
        await activeManager.close();
        expect(observer.observations.every((entry) => entry.close.mock.calls.length === 1)).toBe(
          true,
        );
      } finally {
        await manager?.close();
        resetMemoryCoreDreamingStateForTests();
        await state.cleanup();
      }
    },
    30_000,
  );
});
