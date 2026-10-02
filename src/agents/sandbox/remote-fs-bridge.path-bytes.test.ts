import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSandboxFileMutationQueueKey } from "./file-mutation-identity.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform !== "win32")(
  "preserves newline bytes in remote mount roots, existing parents, and new parents",
  async () => {
    const workspaceDir = path.join(
      await fs.realpath(tempDirs.make("remote-path-bytes-")),
      "root\n",
    );
    await fs.mkdir(path.join(workspaceDir, "existing\n"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "existing\n", "note.txt"), "original");
    const bridge = createRemoteShellSandboxFsBridge({
      sandbox: {
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        containerName: "remote-path-bytes",
        containerWorkdir: workspaceDir,
        docker: {},
      },
      runtime: {
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
        runRemoteShellScript: createLocalRemoteShellScriptRunner(),
      },
    });

    const absentPath = path.join(workspaceDir, "absent");
    for (const filePath of [absentPath, `${absentPath}/`]) {
      await expect(
        resolveSandboxFileMutationQueueKey({ bridge, root: workspaceDir, filePath }),
      ).resolves.toBe(`${workspaceDir}\0${absentPath}`);
    }

    await expect(bridge.readFileWithSource!({ filePath: "existing\n/note.txt" })).resolves.toEqual({
      data: Buffer.from("original"),
      canonicalPath: path.join(workspaceDir, "existing\n", "note.txt"),
      workspaceRelativePath: "existing\n/note.txt",
    });
    const destination = await bridge.resolvePinnedMutationTarget!({
      filePath: "new\n/note.txt",
      action: "write",
    });
    expect(destination).toEqual({
      policyPath: path.join(workspaceDir, "new\n", "note.txt"),
      pinnedPath: path.join(workspaceDir, "new\n", "note.txt"),
    });
    await bridge.writeFile({
      filePath: "new\n/note.txt",
      data: "created",
      pinnedPath: destination.pinnedPath,
    });
    await expect(fs.readFile(path.join(workspaceDir, "new\n", "note.txt"), "utf8")).resolves.toBe(
      "created",
    );
  },
);
