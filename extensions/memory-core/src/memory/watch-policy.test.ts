import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryWatchPolicy } from "./watch-policy.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "memory-watch-policy" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});
const signal = () => new AbortController().signal;
function policy(extras: string[] = []) {
  return new MemoryWatchPolicy(state.workspaceDir, {
    extraPaths: extras,
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
}

it("observes root-entry links without following sources the indexer rejects", async () => {
  await fs.mkdir(state.path("target"));
  await fs.writeFile(state.path("target", "note.md"), "trusted");
  await fs.symlink(state.path("target"), path.join(state.workspaceDir, "memory"), "junction");
  await fs.symlink(state.path("target", "note.md"), path.join(state.workspaceDir, "MEMORY.md"));
  await fs.symlink(state.path("target"), state.path("extra-link"), "junction");
  const owner = policy([state.path("extra-link")]);
  const groups = await owner.observations(signal());
  const selected = groups.flatMap((group) =>
    group.selections.map((selection) => ({
      path: path.resolve(group.root.rootDir, selection.scope.path),
      ...selection,
    })),
  );
  expect(selected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: path.join(state.workspaceDir, "memory"),
        alias: true,
        scope: expect.objectContaining({ kind: "entry" }),
      }),
      expect.objectContaining({
        path: path.join(state.workspaceDir, "MEMORY.md"),
        alias: true,
        scope: expect.objectContaining({ kind: "entry" }),
      }),
      expect.objectContaining({ path: state.path("extra-link"), alias: true, core: false }),
    ]),
  );
  expect(selected.every((selection) => !selection.path.startsWith(state.path("target")))).toBe(
    true,
  );
});

it("observes the first intermediate alias separately and retains configured parent-alias behavior", async () => {
  await fs.mkdir(state.path("real", "workspace"), { recursive: true });
  await fs.mkdir(state.path("real", "extra"));
  await fs.symlink(state.path("real"), state.path("alias"), "junction");
  const owner = new MemoryWatchPolicy(state.path("alias", "workspace"), {
    extraPaths: [state.path("alias", "extra")],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
  const groups = await owner.observations(signal());
  const scopes = groups.flatMap((group) =>
    owner.scopes(group).map((scope) => path.resolve(group.root.rootDir, scope.path)),
  );
  expect(scopes).toContain(state.path("alias"));
  expect(scopes).toContain(state.path("real", "extra"));
  expect(scopes).not.toContain(state.path("alias", "extra"));
});

it("retains successful Roots across missing-descendant creation and never repins a replaced authority", async () => {
  await fs.mkdir(state.path("outer"));
  const owner = policy([state.path("outer", "missing", "notes")]);
  const first = await owner.observations(signal());
  await fs.mkdir(state.path("outer", "missing", "notes"), { recursive: true });
  const next = await owner.observations(signal());
  expect(next.map((group) => group.root)).toEqual(first.map((group) => group.root));
  // outer/missing was absent during first admission; authority remains outer.
  await fs.rename(state.path("outer"), state.path("outer-old"));
  await fs.mkdir(state.path("outer", "missing", "notes"), { recursive: true });
  await expect(owner.observations(signal())).rejects.toBeDefined();
});

it("retains partial Root admission when a later configured boundary temporarily fails", async () => {
  await fs.mkdir(state.path("first"));
  await fs.mkdir(state.path("second"));
  const owner = policy([state.path("first", "notes"), state.path("second", "notes")]);
  const original = fs.lstat.bind(fs);
  const failure = new Error("admission denied");
  const stat = vi
    .spyOn(fs, "lstat")
    .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === state.path("second")) {
        throw failure;
      }
      return await original(...args);
    });
  await expect(owner.observations(signal())).rejects.toBe(failure);
  stat.mockRestore();
  await fs.rename(state.path("first"), state.path("first-old"));
  await fs.mkdir(state.path("first"));
  // If failure discarded successful admissions, this would silently repin first.
  await expect(owner.observations(signal())).rejects.toBeDefined();
});

it("filters ignored descendants, not explicitly selected roots or their ancestors", async () => {
  const workspace = state.path("node_modules", "selected-workspace");
  const extra = state.path(".git", "selected-import");
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  await fs.mkdir(extra, { recursive: true });
  const owner = new MemoryWatchPolicy(workspace, {
    extraPaths: [extra],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
  const groups = await owner.observations(signal());
  for (const file of [path.join(workspace, "memory", "note.md"), path.join(extra, "import.md")]) {
    const group = groups.find((entry) =>
      entry.selections.some((selection) => file.startsWith(selection.lexical + path.sep)),
    )!;
    const relative = path.relative(group.root.rootDir, file);
    expect(owner.exclude(group, { path: relative, kind: "file" })).toBe(false);
    expect(owner.select(group, relative, false)).toMatchObject({ relative, sample: true });
    const ignored = path.relative(
      group.root.rootDir,
      path.join(path.dirname(file), "node_modules", "skip.md"),
    );
    expect(owner.exclude(group, { path: ignored, kind: "file" })).toBe(true);
    expect(owner.select(group, ignored, false)).toBeUndefined();
  }
});

it("selects configured patterns and multimodal files while pruning unrelated descendants", async () => {
  const extra = state.path("extra");
  const owner = new MemoryWatchPolicy(state.workspaceDir, {
    extraPaths: [{ path: extra, pattern: "..notes/**/*" }, state.path("other")],
    multimodal: { enabled: true, modalities: ["image", "audio"], maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
  const group = (await owner.observations(signal())).find((entry) =>
    entry.selections.some((selection) => selection.lexical === extra),
  )!;
  const relative = (name: string) => path.relative(group.root.rootDir, path.join(extra, name));
  for (const file of ["..notes/note.md", "..notes/PHOTO.PNG", "..notes/voice.WAV"]) {
    expect(owner.select(group, relative(file), false)).toMatchObject({ relative: relative(file) });
  }
  for (const file of ["drafts/skip.md", "..notes/metadata.json", "node_modules/pkg/note.md"]) {
    expect(owner.select(group, relative(file), false)).toBeUndefined();
  }
  for (const directory of ["node_modules", ".venv"]) {
    expect(owner.exclude(group, { path: relative(directory), kind: "directory" })).toBe(true);
  }
  expect(owner.exclude(group, { path: relative("..notes"), kind: "directory" })).toBe(false);
  expect(owner.exclude(group, { path: relative("nested-link"), kind: "symlink" })).toBe(true);
});
