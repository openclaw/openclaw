import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
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

it("restores shared subscriptions after a worker crash and joins its final exit", async ({
  signal,
}) => {
  const wait = <T>(work: Promise<T>) => withinTest(work, signal);
  const waitForEdits = (edits: ReturnType<typeof createDeferred<void>>[]) =>
    wait(Promise.all(edits.map((edit) => edit.promise)));
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
    const extraRoot = state.path("extra");
    const extraFiles = [path.join(extraRoot, "first.md"), path.join(extraRoot, "second.md")];
    await fs.mkdir(memory);
    await fs.mkdir(extraRoot);
    await fs.writeFile(note, "initial memory");
    await Promise.all(extraFiles.map((file) => fs.writeFile(file, "initial extra memory")));
    const firstEdits = [createDeferred<void>(), createDeferred<void>()];
    const recovered = [createDeferred<void>(), createDeferred<void>()];
    const gapEdits = [createDeferred<void>(), createDeferred<void>()];
    const extraEdits = [createDeferred<void>(), createDeferred<void>()];
    const sawFailure = [false, false];
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
            extraPaths: [extraFiles[index]!],
            multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
            sync: { watchDebounceMs: 0 },
          },
          onDirty: dirty[index],
          onUnavailable: unavailable,
          onState: (facts) => {
            sawFailure[index] ||= facts.health.some((entry) => entry.state === "unavailable");
            if (
              sawFailure[index] &&
              !facts.capacityDegraded &&
              facts.health.length > 0 &&
              facts.health.every((entry) => entry.state === "ready")
            ) {
              recovered[index]!.resolve();
            }
          },
          onChange: async () => {
            const afterRecovery = sawFailure[index] && !owners[index]!.capacityDegraded;
            const [contents, extra] = await Promise.all([
              fs.readFile(note, "utf8"),
              fs.readFile(extraFiles[index]!, "utf8"),
            ]);
            observed[index]!.push(contents, extra);
            if (contents === "first") {
              firstEdits[index]!.resolve();
            }
            if (index === 1 && extra === "survivor") {
              survivingEdit.resolve();
            }
            if (afterRecovery && contents === "outage" && extra === `gap:${index}`) {
              gapEdits[index]!.resolve();
            }
            if (extra === `restored:${index}`) {
              extraEdits[index]!.resolve();
            }
          },
        }),
      );
    }
    await wait(Promise.all(owners.map((owner) => owner.start())));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.threadId).toBeGreaterThan(0);
    for (const owner of owners) {
      expect(owner.health().length).toBeGreaterThan(0);
      expect(owner.health().every((entry) => entry.state === "ready" && entry.mode === mode)).toBe(
        true,
      );
      expect(owner.capacityDegraded).toBe(false);
    }
    await fs.writeFile(note, "first");
    await waitForEdits(firstEdits);
    expect(dirty.every((callback) => callback.mock.calls.length > 0)).toBe(true);

    const originalWorker = workers[0]!;
    originalWorker.once("exit", () => {
      // No replacement can start until this callback returns: these edits have no observer.
      writeFileSync(note, "outage");
      for (const [index, file] of extraFiles.entries()) {
        writeFileSync(file, `gap:${index}`);
      }
    });
    await wait(originalWorker.terminate());
    expect(originalWorker.threadId).toBe(-1);
    for (const owner of owners) {
      expect(owner.capacityDegraded).toBe(true);
      expect(owner.health().every((entry) => entry.state === "unavailable")).toBe(true);
    }
    expect(unavailable).toHaveBeenCalledTimes(2);
    await waitForEdits([...recovered, ...gapEdits]);
    expect(workers).toHaveLength(2);
    const replacementWorker = workers[1]!;
    expect(replacementWorker.threadId).toBeGreaterThan(0);
    for (const [index, file] of extraFiles.entries()) {
      await fs.writeFile(file, `restored:${index}`);
      await wait(extraEdits[index]!.promise);
    }

    await wait(owners[0]!.close());
    const closedCallbacks = observed[0]!.length;
    expect(replacementWorker.threadId).toBeGreaterThan(0);
    await fs.writeFile(extraFiles[1]!, "survivor");
    await wait(survivingEdit.promise);
    expect(observed[0]).toHaveLength(closedCallbacks);
    expect(observed[1]).toContain("survivor");
    await wait(owners[1]!.close());
    expect(replacementWorker.threadId).toBe(-1);
    expect(workers).toHaveLength(2);
    expect(unavailable).toHaveBeenCalledTimes(2);
  } finally {
    const closing = Promise.allSettled(owners.map((owner) => owner.close()));
    try {
      await wait(closing);
    } finally {
      // Test cancellation must also retire workers if the lifecycle under test stalls.
      await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
      await closing;
      vi.unstubAllEnvs();
      await state.cleanup();
    }
  }
});
