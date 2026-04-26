import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRoots } from "./pi-tools.fs-roots.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceReadTool,
  createHostWorkspaceWriteTool,
} from "./pi-tools.read.js";

describe("host fs roots write/edit operations", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("uses configured fs roots for host write/edit operations outside the workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-workspace-"));
    const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-roots-"));
    tempDirs.push(workspaceDir, allowedDir);

    const roots = resolveRoots([{ path: allowedDir, kind: "dir", access: "rw" }]);
    const writeTool = createHostWorkspaceWriteTool(workspaceDir, {
      workspaceOnly: false,
      roots,
    });
    const editTool = createHostWorkspaceEditTool(workspaceDir, {
      workspaceOnly: false,
      roots,
    });
    const target = path.join(allowedDir, "note.txt");

    await writeTool.execute("tc-roots-write", { path: target, content: "hello" });
    expect(await fs.readFile(target, "utf8")).toBe("hello");

    await editTool.execute("tc-roots-edit", {
      path: target,
      edits: [{ oldText: "hello", newText: "updated" }],
    });
    expect(await fs.readFile(target, "utf8")).toBe("updated");
  });

  it("creates a missing rw directory root on first write", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-workspace-"));
    const rootsParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-roots-parent-"));
    tempDirs.push(workspaceDir, rootsParent);

    const allowedDir = path.join(rootsParent, "provisioned-root");
    const roots = resolveRoots([{ path: allowedDir, kind: "dir", access: "rw" }]);
    const writeTool = createHostWorkspaceWriteTool(workspaceDir, {
      workspaceOnly: false,
      roots,
    });
    const target = path.join(allowedDir, "nested", "note.txt");

    await writeTool.execute("tc-roots-create-root", { path: target, content: "hello" });
    expect(await fs.readFile(target, "utf8")).toBe("hello");
  });

  it("preserves exact-match file roots for host write/edit operations", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-workspace-"));
    const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-file-root-"));
    tempDirs.push(workspaceDir, fileDir);

    const target = path.join(fileDir, "only.txt");
    const sibling = path.join(fileDir, "sibling.txt");
    const roots = resolveRoots([{ path: target, kind: "file", access: "rw" }]);
    const writeTool = createHostWorkspaceWriteTool(workspaceDir, {
      workspaceOnly: false,
      roots,
    });
    const editTool = createHostWorkspaceEditTool(workspaceDir, {
      workspaceOnly: false,
      roots,
    });

    await writeTool.execute("tc-file-root-write", { path: target, content: "hello" });
    expect(await fs.readFile(target, "utf8")).toBe("hello");

    await editTool.execute("tc-file-root-edit", {
      path: target,
      edits: [{ oldText: "hello", newText: "updated" }],
    });
    expect(await fs.readFile(target, "utf8")).toBe("updated");

    await expect(
      writeTool.execute("tc-file-root-denied", { path: sibling, content: "nope" }),
    ).rejects.toThrow(/outside allowed filesystem roots/i);
  });

  it("uses configured fs roots for host read operations outside the workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-workspace-"));
    const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-roots-"));
    tempDirs.push(workspaceDir, allowedDir);

    const target = path.join(allowedDir, "note.txt");
    await fs.writeFile(target, "hello from roots");

    const roots = resolveRoots([{ path: allowedDir, kind: "dir", access: "rw" }]);
    const readTool = createHostWorkspaceReadTool(workspaceDir, { roots });
    const result = await readTool.execute("tc-roots-read", { path: target });

    expect(result.content).toContainEqual({
      type: "text",
      text: "hello from roots",
    });
  });

  it.runIf(process.platform !== "win32")(
    "blocks host read symlink aliases that escape configured roots",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-workspace-"));
      const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-roots-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-outside-"));
      tempDirs.push(workspaceDir, allowedDir, outsideDir);

      const outsideFile = path.join(outsideDir, "secret.txt");
      const aliasFile = path.join(allowedDir, "alias.txt");
      await fs.writeFile(outsideFile, "secret");
      await fs.symlink(outsideFile, aliasFile);

      const roots = resolveRoots([{ path: allowedDir, kind: "dir", access: "rw" }]);
      const readTool = createHostWorkspaceReadTool(workspaceDir, { roots });

      await expect(readTool.execute("tc-roots-read-symlink", { path: aliasFile })).rejects.toThrow(
        /outside workspace root|regular file under root/i,
      );
    },
  );
});
