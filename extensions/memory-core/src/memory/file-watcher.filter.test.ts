import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let watcher: MemoryFileWatcher | undefined;
beforeEach(async () => {
  observer.reset();
  state = await createOpenClawTestState({ label: "memory-watch-filter" });
});
afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  vi.useRealTimers();
  await state.cleanup();
});

it("filters irrelevant removals but preserves indexable files and possible directories", async () => {
  const workspaceDir = state.workspaceDir;
  const extraDir = path.join(workspaceDir, "extra");
  for (const dir of [
    "memory",
    "extra/notes",
    "extra/data",
    "extra/archive/report.json",
    "extra/media",
  ]) {
    await fs.mkdir(path.join(workspaceDir, dir), { recursive: true });
  }
  const changed = createDeferred<void>();
  const onDirty = vi.fn();
  const onChange = vi.fn(() => changed.resolve());
  const onUnavailable = vi.fn();
  watcher = new MemoryFileWatcher({
    runInBackgroundContext: AsyncLocalStorage.snapshot(),
    workspaceDir,
    agentId: "main",
    settings: {
      extraPaths: [
        { path: extraDir, pattern: "notes/*.md" },
        { path: extraDir, pattern: "archive/**/*.md" },
        { path: extraDir, pattern: "media/*" },
        { path: workspaceDir, pattern: "other/**/*.md" },
      ],
      multimodal: { enabled: true, modalities: ["image"], maxFileBytes: 1024 },
      sync: { watchDebounceMs: 1500 },
    },
    onDirty,
    onChange,
    onUnavailable,
  });
  await watcher.start();
  vi.useFakeTimers();

  const entry = observer.observations.find((observation) =>
    observation.options.scopes.some(
      (scope) => path.resolve(observation.root.rootDir, scope.path) === workspaceDir,
    ),
  );
  if (!entry) {
    throw new Error("Missing workspace observation");
  }
  const relative = (file: string) =>
    path.relative(entry.root.rootDir, path.join(workspaceDir, file));
  const removed = (file: string) => entry.dirty([{ path: relative(file), type: "structural" }]);

  // fs-safe retains exclusions for known removed entries. Structural hints
  // without a known kind must still allow a directory with this same name.
  const json = relative("extra/archive/state.json");
  expect(entry.options.exclude?.({ path: json, kind: "file" })).toBe(true);
  expect(entry.options.exclude?.({ path: json, kind: "directory" })).toBe(false);

  for (const file of ["extra/data/state.json", "extra/notes/write.tmp", "extra/data/skip.md"]) {
    const absolute = path.join(workspaceDir, file);
    await fs.writeFile(absolute, "temporary");
    await fs.unlink(absolute);
    removed(file);
  }
  await fs.rmdir(path.join(extraDir, "data"));
  removed("extra/data");
  await vi.advanceTimersByTimeAsync(1500);
  expect(onDirty).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();

  for (const file of [
    "extra/notes/keep.md",
    "extra/media/PHOTO.PNG",
    "MEMORY.md",
    "USER.md",
    "memory/keep.md",
  ]) {
    const absolute = path.join(workspaceDir, file);
    await fs.writeFile(absolute, "indexed");
    await fs.unlink(absolute);
    removed(file);
  }
  await fs.writeFile(path.join(extraDir, "archive/report.json/nested.md"), "indexed");
  await fs.rm(path.join(extraDir, "archive/report.json"), { recursive: true });
  removed("extra/archive/report.json");
  expect(onDirty).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1500);
  await changed.promise;
  expect(onChange).toHaveBeenCalledOnce();
  expect(onUnavailable).not.toHaveBeenCalled();
});
