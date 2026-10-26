import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { git, initializeGitFixture } from "./worktrees/git-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => __setFsSafeTestHooksForTest());

const repository = (parent: string, name: string) =>
  initializeGitFixture(parent, name, "seed.txt", "fixture\n");

function fileTools(root: string) {
  const tools = createCoreCodingTools({
    codingRoot: root,
    containmentRoot: root,
    includeBaseCodingTools: true,
    shellTools: "patch-only",
    readOnly: false,
    applyPatchEnabled: true,
    applyPatchWorkspaceOnly: true,
    workspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
  });
  return async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name)!;
    return tool.execute(name, args);
  };
}

it("uses newly registered linked worktrees for host file tools and observes unregistration", async () => {
  const fixture = await fs.realpath(tempDirs.make("openclaw-linked-worktrees-"));
  const root = await repository(fixture, "repo");
  const execute = fileTools(root);
  const linked = path.join(fixture, "linked");
  await git(root, "worktree", "add", "--quiet", "--detach", linked);
  const target = path.join(linked, "nested", "note.txt");

  await execute("write", { path: target, content: "created\n" });
  await execute("edit", { path: target, edits: [{ oldText: "created", newText: "edited" }] });
  await expect(fs.readFile(target, "utf8")).resolves.toBe("edited\n");
  const read = await execute("read", { path: target });
  expect(read.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("edited") })]),
  );
  await execute("apply_patch", {
    input: `*** Begin Patch\n*** Add File: ${path.join(linked, "patch.txt")}\n+created\n*** Update File: ${target}\n@@\n-edited\n+patched\n*** End Patch`,
  });
  await expect(fs.readFile(path.join(linked, "patch.txt"), "utf8")).resolves.toBe("created\n");
  await expect(fs.readFile(target, "utf8")).resolves.toBe("patched\n");

  // A linked root must resolve the same common repository as the main checkout.
  const sibling = path.join(fixture, "sibling");
  await git(root, "worktree", "add", "--quiet", "--detach", sibling);
  await fileTools(linked)("write", { path: path.join(sibling, "note.txt"), content: "created\n" });

  const gitDir = await git(linked, "rev-parse", "--absolute-git-dir");
  let prepared = false;
  __setFsSafeTestHooksForTest({
    beforePinnedWriteParentAdmission: async (preparedPath) => {
      if (preparedPath === target) {
        prepared = true;
        await fs.rm(path.join(gitDir, "gitdir"));
      }
    },
  });
  await expect(execute("write", { path: target, content: "denied\n" })).rejects.toThrow(
    /escapes .*root/,
  );
  expect(prepared).toBe(true);
  __setFsSafeTestHooksForTest();
  await expect(execute("write", { path: target, content: "still denied\n" })).rejects.toThrow(
    /escapes .*root/,
  );
  await expect(fs.readFile(target, "utf8")).resolves.toBe("patched\n");
});

it("refuses forged registrations, foreign worktrees, Git metadata, and linked-worktree escapes", async () => {
  const fixture = await fs.realpath(tempDirs.make("openclaw-linked-worktree-denials-"));
  const root = await repository(fixture, "repo");
  const linked = path.join(fixture, "linked");
  await git(root, "worktree", "add", "--quiet", "--detach", linked);
  const forged = path.join(fixture, "forged");
  await fs.mkdir(forged);
  await fs.copyFile(path.join(linked, ".git"), path.join(forged, ".git"));
  const foreign = await repository(fixture, "foreign");
  const foreignLinked = path.join(fixture, "foreign-linked");
  await git(foreign, "worktree", "add", "--quiet", "--detach", foreignLinked);
  const outside = path.join(fixture, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(linked, "escape"), "dir");
  await fs.symlink(path.join(root, ".git"), path.join(linked, "metadata"), "dir");
  const execute = fileTools(root);

  for (const target of [
    path.join(forged, "note.txt"),
    path.join(foreignLinked, "note.txt"),
    path.join(linked, ".git"),
    path.join(root, ".git", "config"),
    path.join(linked, "escape", "note.txt"),
    path.join(linked, "metadata", "config"),
  ]) {
    if (!target.endsWith(".git") && !target.endsWith("config")) {
      await fs.writeFile(target, "created\n");
    }
    const before = await fs.readFile(target, "utf8");
    const operations = [
      ["write", { path: target, content: "denied\n" }],
      ["edit", { path: target, edits: [{ oldText: "created", newText: "denied" }] }],
      [
        "apply_patch",
        {
          input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-created\n+denied\n*** End Patch`,
        },
      ],
    ] as const;
    for (const [name, args] of operations) {
      await expect(execute(name, args)).rejects.toThrow(/escapes .*root|Git metadata/);
      await expect(fs.readFile(target, "utf8")).resolves.toBe(before);
    }
  }
});
