import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));

it("filters irrelevant removals but preserves indexable files and possible directories", async ({
  onTestFinished,
}) => {
  const state = await createOpenClawTestState({ label: "memory-watch-filter" });
  const owned: { watcher?: MemoryFileWatcher } = {};
  onTestFinished(async () => {
    await owned.watcher?.close();
    vi.useRealTimers();
    await state.cleanup();
  });
  const workspaceDir = state.workspaceDir;
  const extraDir = path.join(workspaceDir, "extra");
  await fs.mkdir(extraDir);
  const changed = createDeferred<void>();
  const onDirty = vi.fn();
  const onChange = vi.fn(() => changed.resolve());
  const onUnavailable = vi.fn();
  owned.watcher = new MemoryFileWatcher({
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
  await owned.watcher.start();
  vi.useFakeTimers();

  const entry = observer.observations.find(
    ({ root }) => root.rootDir === path.dirname(workspaceDir),
  )!;
  const relative = (file: string) =>
    path.relative(entry.root.rootDir, path.join(workspaceDir, file));
  const removed = (file: string) => entry.dirty([{ path: relative(file), type: "structural" }]);

  const json = relative("extra/archive/state.json");
  expect(entry.options.exclude?.({ path: json, kind: "file" })).toBe(true);
  expect(entry.options.exclude?.({ path: json, kind: "directory" })).toBe(false);

  for (const file of ["data/state.json", "notes/write.tmp", "data/skip.md", "data"]) {
    removed(`extra/${file}`);
  }
  await vi.advanceTimersByTimeAsync(1500);
  expect([onDirty.mock.calls, onChange.mock.calls]).toEqual([[], []]);

  for (const file of [
    "extra/notes/keep.md",
    "extra/media/PHOTO.PNG",
    "MEMORY.md",
    "USER.md",
    "memory/keep.md",
  ]) {
    removed(file);
  }
  removed("extra/archive/report.json");
  expect(onDirty).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1500);
  await changed.promise;
  expect(onChange).toHaveBeenCalledOnce();
  expect(onUnavailable).not.toHaveBeenCalled();
});
