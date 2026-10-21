import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";

// Run remote shell snippets locally so path and permission checks are exercised
// without an SSH server.
const runRemoteShellScript: RemoteShellSandboxHandle["runRemoteShellScript"] =
  createLocalRemoteShellScriptRunner({ shellArg0: "openclaw-test" });
const dirs = useAutoCleanupTempDirTracker(afterEach);
const skillFile = "skills/demo/SKILL.md";
const materializedFile = `.openclaw/sandbox-skills/${skillFile}`;

async function fixture(...roots: string[]) {
  const stateDir = dirs.make("openclaw-skills-bridge-");
  const workspaceDir = path.join(stateDir, "workspace");
  const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
  const skillsWorkspaceDir = path.join(stateDir, "sandbox-state");
  await Promise.all(
    [workspaceDir, ...roots.map((root) => path.join(stateDir, root))].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  return { workspaceDir, remoteWorkspaceDir, skillsWorkspaceDir };
}

async function createBridge(
  workspaceDir: string,
  remoteWorkspaceDir = workspaceDir,
  skillsWorkspaceDir?: string,
) {
  const localRoot = await fs.realpath(workspaceDir);
  const remoteRoot = await fs.realpath(remoteWorkspaceDir);
  const bridge = createRemoteShellSandboxFsBridge({
    sandbox: createSandbox({
      workspaceDir: localRoot,
      agentWorkspaceDir: localRoot,
      skillsWorkspaceDir: skillsWorkspaceDir && (await fs.realpath(skillsWorkspaceDir)),
    }),
    runtime: {
      remoteWorkspaceDir: remoteRoot,
      remoteAgentWorkspaceDir: remoteRoot,
      runRemoteShellScript,
    },
  });
  return { bridge, remoteRoot };
}

async function expectWriteRejected(
  bridge: ReturnType<typeof createRemoteShellSandboxFsBridge>,
  cwd: string,
  filePath: string,
  targetPath = filePath,
) {
  await expect(bridge.writeFile({ filePath, cwd, data: "# Demo\n" })).rejects.toThrow(/read-only/);
  await expect(fs.stat(path.join(cwd, targetPath))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("workspace skills bridge mount policy", () => {
  it("resolves workspace skill roots as read-only", async () => {
    const { workspaceDir, skillsWorkspaceDir } = await fixture(
      "workspace/skills/demo",
      "workspace/.agents/skills/demo",
      "sandbox-state/skills/demo",
    );

    const sandbox = createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      skillsWorkspaceDir,
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const resolve = (filePath: string) =>
      resolveSandboxFsPathWithMounts({
        filePath,
        cwd: sandbox.workspaceDir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts,
      });

    expect(
      [
        "normal.txt",
        skillFile,
        `.agents/${skillFile}`,
        materializedFile,
        `/workspace/${skillFile}`,
        `/workspace/${materializedFile}`,
      ].map((file) => resolve(file).writable),
    ).toEqual([true, false, false, false, false, false]);
    expect(resolve(materializedFile).hostPath).toBe(path.join(skillsWorkspaceDir, skillFile));
  });
});

describe.runIf(process.platform !== "win32")("remote skills bridge", () => {
  it("rejects remote bridge writes under remote-only skill roots", async () => {
    const { workspaceDir, remoteWorkspaceDir, skillsWorkspaceDir } = await fixture(
      "remote-workspace/skills/demo",
      "sandbox-state/skills/demo",
    );
    const { bridge, remoteRoot } = await createBridge(
      workspaceDir,
      remoteWorkspaceDir,
      skillsWorkspaceDir,
    );
    await expectWriteRejected(bridge, remoteRoot, skillFile);
    await expectWriteRejected(bridge, remoteRoot, materializedFile);
  });

  it("rejects remote bridge mkdirp under skill roots from container cwd", async () => {
    const { workspaceDir, remoteWorkspaceDir } = await fixture(
      "workspace/skills/demo",
      "remote-workspace/skills/demo",
    );
    const { bridge, remoteRoot } = await createBridge(workspaceDir, remoteWorkspaceDir);

    await expect(
      bridge.mkdirp({ filePath: "skills/demo/generated", cwd: remoteRoot }),
    ).rejects.toThrow(/read-only/);
    await expect(
      fs.stat(path.join(remoteRoot, "skills", "demo", "generated")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// Canonical path checks invoke GNU readlink/stat on the local fixture host.
describe.runIf(process.platform === "linux")("workspace skills bridge (GNU shell)", () => {
  it("allows remote bridge writes under absent skill roots", async () => {
    const { workspaceDir } = await fixture();
    const { bridge, remoteRoot } = await createBridge(workspaceDir);

    await bridge.writeFile({ filePath: "skills/new.txt", data: "created" });
    await expect(fs.readFile(path.join(remoteRoot, "skills", "new.txt"), "utf8")).resolves.toBe(
      "created",
    );
  });

  it("rejects remote bridge writes through symlinks into skill roots", async () => {
    // Symlink resolution must happen on the remote side too; otherwise writes
    // can bypass read-only skill root detection.
    const { workspaceDir, remoteWorkspaceDir } = await fixture("remote-workspace/skills/demo");
    await fs.symlink("skills", path.join(remoteWorkspaceDir, "link"), "dir");
    const { bridge, remoteRoot } = await createBridge(workspaceDir, remoteWorkspaceDir);
    await expectWriteRejected(bridge, remoteRoot, "link/demo/SKILL.md", skillFile);
  });
});
