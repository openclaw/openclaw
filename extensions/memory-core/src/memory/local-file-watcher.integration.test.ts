import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { LocalMemoryFileWatcher } from "./local-file-watcher.js";

const workers = vi.hoisted(() => [] as Worker[]);
vi.mock("openclaw/plugin-sdk/process-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    createCpuTrackedWorker: (...args: Parameters<typeof actual.createCpuTrackedWorker>) => {
      const worker = actual.createCpuTrackedWorker(...args);
      workers.push(worker);
      return worker;
    },
  };
});

it("observes real file edits through one shared worker and joins its final exit", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({ label: "local-memory-worker" });
  const owners: LocalMemoryFileWatcher[] = [];
  const unavailable = vi.fn();
  // fs-safe supports guarded scans on Bun, but native event callbacks require Node.
  const mode = process.versions.bun ? "poll" : "events";
  vi.stubEnv("CHOKIDAR_USEPOLLING", mode === "poll" ? "true" : "false");
  vi.stubEnv("CHOKIDAR_INTERVAL", "40");
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "require");
  try {
    const memory = path.join(state.workspaceDir, "memory");
    const note = path.join(memory, "note.md");
    await fs.mkdir(memory);
    await fs.writeFile(note, "initial memory");
    const firstEdits = [createDeferred<void>(), createDeferred<void>()];
    const survivingEdit = createDeferred<void>();
    const observed: string[][] = [[], []];
    const dirty = [vi.fn(), vi.fn()];
    for (const index of [0, 1]) {
      owners.push(
        new LocalMemoryFileWatcher({
          workspaceDir: state.workspaceDir,
          agentId: "main",
          runInBackgroundContext: AsyncLocalStorage.snapshot(),
          settings: {
            extraPaths: [],
            multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
            sync: { watchDebounceMs: 0 },
          },
          onDirty: dirty[index],
          onUnavailable: unavailable,
          onChange: async () => {
            const contents = await fs.readFile(note, "utf8");
            observed[index]!.push(contents);
            if (contents === "first shared edit") {
              firstEdits[index]!.resolve();
            }
            if (index === 1 && contents === "surviving watcher edit") {
              survivingEdit.resolve();
            }
          },
        }),
      );
    }
    await withinTest(Promise.all(owners.map((owner) => owner.start())), signal);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.threadId).toBeGreaterThan(0);
    for (const owner of owners) {
      expect(owner.health().length).toBeGreaterThan(0);
      expect(owner.health().every((entry) => entry.state === "ready" && entry.mode === mode)).toBe(
        true,
      );
      expect(owner.capacityDegraded).toBe(false);
    }
    await fs.writeFile(note, "first shared edit");
    await withinTest(Promise.all(firstEdits.map((edit) => edit.promise)), signal);
    expect(dirty.every((callback) => callback.mock.calls.length > 0)).toBe(true);

    await withinTest(owners[0]!.close(), signal);
    const closedCallbacks = observed[0]!.length;
    expect(workers[0]!.threadId).toBeGreaterThan(0);
    await fs.writeFile(note, "surviving watcher edit");
    await withinTest(survivingEdit.promise, signal);
    expect(observed[0]).toHaveLength(closedCallbacks);
    expect(observed[1]).toContain("surviving watcher edit");
    await withinTest(owners[1]!.close(), signal);
    expect(workers[0]!.threadId).toBe(-1);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    const closing = Promise.allSettled(owners.map((owner) => owner.close()));
    try {
      await withinTest(closing, signal);
    } finally {
      // Test cancellation must also retire workers if the lifecycle under test stalls.
      await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
      await closing;
      vi.unstubAllEnvs();
      await state.cleanup();
    }
  }
});
