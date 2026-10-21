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
function policy(
  extraPaths: ConstructorParameters<typeof MemoryWatchPolicy>[1]["extraPaths"] = [],
  workspace = state.workspaceDir,
  modalities: ("image" | "audio")[] = [],
) {
  return new MemoryWatchPolicy(workspace, {
    extraPaths,
    multimodal: { enabled: modalities.length > 0, modalities, maxFileBytes: 10485760 },
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
  const selected = new Map(
    (await owner.observations(signal())).flatMap(({ root, selections }) =>
      selections.map(
        (selection) => [path.resolve(root.rootDir, selection.scope.path), selection] as const,
      ),
    ),
  );
  for (const name of ["memory", "MEMORY.md"]) {
    expect(selected.get(path.join(state.workspaceDir, name))).toMatchObject({
      alias: true,
      scope: { kind: "entry" },
    });
  }
  expect(selected.get(state.path("extra-link"))).toMatchObject({ alias: true, core: false });
  expect([...selected.keys()].some((entry) => entry.startsWith(state.path("target")))).toBe(false);
});

it("observes the first intermediate alias separately and retains configured parent-alias behavior", async () => {
  await fs.mkdir(state.path("real", "workspace"), { recursive: true });
  await fs.mkdir(state.path("real", "extra"));
  await fs.symlink(state.path("real"), state.path("alias"), "junction");
  const owner = policy([state.path("alias", "extra")], state.path("alias", "workspace"));
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

it("selects configured patterns and multimodal files while pruning unrelated descendants", async () => {
  const extra = state.path("extra");
  const owner = policy(
    [{ path: extra, pattern: "..notes/**/*" }, state.path("other")],
    state.workspaceDir,
    ["image", "audio"],
  );
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
