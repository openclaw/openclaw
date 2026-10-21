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
const p = (...parts: string[]) => state.path(...parts);
const observe = (owner: MemoryWatchPolicy) => owner.observations(new AbortController().signal);
type ExtraPaths = ConstructorParameters<typeof MemoryWatchPolicy>[1]["extraPaths"];
function policy(extraPaths: ExtraPaths = [], workspace = state.workspaceDir, media = false) {
  const modalities: ("image" | "audio")[] = media ? ["image", "audio"] : [];
  return new MemoryWatchPolicy(workspace, {
    extraPaths,
    multimodal: { enabled: media, modalities, maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
}

it("observes root-entry links without following sources the indexer rejects", async () => {
  await fs.mkdir(p("target"));
  await fs.writeFile(p("target/note.md"), "trusted");
  await fs.symlink(p("target"), path.join(state.workspaceDir, "memory"), "junction");
  await fs.symlink(p("target/note.md"), path.join(state.workspaceDir, "MEMORY.md"));
  await fs.symlink(p("target"), p("extra-link"), "junction");
  const selected = (await observe(policy([p("extra-link")]))).flatMap(({ root, selections }) =>
    selections.map(
      (s) => [path.resolve(root.rootDir, s.scope.path), s.alias, s.scope.kind, s.core] as const,
    ),
  );
  for (const name of ["memory", "MEMORY.md"]) {
    expect(selected).toContainEqual([path.join(state.workspaceDir, name), true, "entry", true]);
  }
  expect(selected).toContainEqual([p("extra-link"), true, "entry", false]);
  expect(selected.some(([entry]) => entry.startsWith(p("target")))).toBe(false);
});

it("observes the first intermediate alias separately and retains configured parent-alias behavior", async () => {
  await fs.mkdir(p("real/workspace"), { recursive: true });
  await fs.mkdir(p("real/extra"));
  await fs.symlink(p("real"), p("alias"), "junction");
  const owner = policy([p("alias/extra")], p("alias/workspace"));
  const scopes = (await observe(owner)).flatMap((group) =>
    owner.scopes(group).map((scope) => path.resolve(group.root.rootDir, scope.path)),
  );
  expect(scopes).toEqual(expect.arrayContaining([p("alias"), p("real/extra")]));
  expect(scopes).not.toContain(p("alias/extra"));
});

it("retains successful Roots across missing-descendant creation and never repins a replaced authority", async () => {
  await fs.mkdir(p("outer"));
  const owner = policy([p("outer/missing/notes")]);
  const first = await observe(owner);
  await fs.mkdir(p("outer/missing/notes"), { recursive: true });
  const next = await observe(owner);
  expect(next.map((group) => group.root)).toEqual(first.map((group) => group.root));
  await fs.rename(p("outer"), p("outer-old"));
  await fs.mkdir(p("outer/missing/notes"), { recursive: true });
  await expect(observe(owner)).rejects.toBeDefined();
});

it("retains partial Root admission when a later configured boundary temporarily fails", async () => {
  await fs.mkdir(p("first"));
  await fs.mkdir(p("second"));
  const owner = policy([p("first/notes"), p("second/notes")]);
  const original = fs.lstat.bind(fs);
  const failure = new Error("admission denied");
  const stat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]) === p("second")) {
      throw failure;
    }
    return await original(...args);
  });
  await expect(observe(owner)).rejects.toBe(failure);
  stat.mockRestore();
  await fs.rename(p("first"), p("first-old"));
  await fs.mkdir(p("first"));
  await expect(observe(owner)).rejects.toBeDefined();
});

it("selects configured patterns and multimodal files while pruning unrelated descendants", async () => {
  const extra = p("extra");
  const owner = policy(
    [{ path: extra, pattern: "..notes/**/*" }, p("other")],
    state.workspaceDir,
    true,
  );
  const group = (await observe(owner)).find((entry) =>
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
