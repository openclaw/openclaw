import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "linux").each(["remove", "rename"] as const)(
  "%s resolves the parent alias without changing sibling files or following the final symlink",
  async (operation) => {
    const stateDir = await fs.realpath(tempDirs.make("remote-parent-alias-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const realDir = path.join(workspaceDir, "real");
    const outsideDir = path.join(stateDir, "outside");
    await fs.mkdir(realDir, { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.symlink(realDir, path.join(workspaceDir, "alias"), "dir");
    await fs.symlink(outsideDir, path.join(workspaceDir, "escape"), "dir");
    const bridge = createRemoteShellSandboxFsBridge({
      sandbox: {
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        containerName: "remote-parent-alias",
        containerWorkdir: workspaceDir,
        docker: {},
      },
      runtime: {
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
        runRemoteShellScript: createLocalRemoteShellScriptRunner(),
      },
    });
    const mutate = (from: string, to: string) =>
      operation === "remove"
        ? bridge.remove({ filePath: from, force: false })
        : bridge.rename({ from, to });

    await fs.writeFile(path.join(workspaceDir, "note.txt"), "root sentinel");
    await fs.writeFile(path.join(realDir, "note.txt"), "requested bytes");
    await mutate("alias/note.txt", "moved.txt");
    await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe(
      "root sentinel",
    );
    await expect(fs.lstat(path.join(realDir, "note.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (operation === "rename") {
      await expect(fs.readFile(path.join(workspaceDir, "moved.txt"), "utf8")).resolves.toBe(
        "requested bytes",
      );
    }

    const linkTarget = path.join(outsideDir, "target.txt");
    await fs.writeFile(linkTarget, "outside target");
    await fs.writeFile(path.join(workspaceDir, "link.txt"), "root link sentinel");
    await fs.symlink(linkTarget, path.join(realDir, "link.txt"));
    await mutate("alias/link.txt", "moved-link.txt");
    await expect(fs.readFile(path.join(workspaceDir, "link.txt"), "utf8")).resolves.toBe(
      "root link sentinel",
    );
    await expect(fs.lstat(path.join(realDir, "link.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(linkTarget, "utf8")).resolves.toBe("outside target");
    if (operation === "rename") {
      await expect(fs.readlink(path.join(workspaceDir, "moved-link.txt"))).resolves.toBe(
        linkTarget,
      );
    }

    await fs.writeFile(path.join(workspaceDir, "escape-target.txt"), "root escape sentinel");
    await fs.writeFile(path.join(outsideDir, "escape-target.txt"), "outside sentinel");
    await expect(mutate("escape/escape-target.txt", "escaped.txt")).rejects.toThrow(
      "escapes allowed mounts",
    );
    await expect(fs.readFile(path.join(workspaceDir, "escape-target.txt"), "utf8")).resolves.toBe(
      "root escape sentinel",
    );
    await expect(fs.readFile(path.join(outsideDir, "escape-target.txt"), "utf8")).resolves.toBe(
      "outside sentinel",
    );
  },
);
