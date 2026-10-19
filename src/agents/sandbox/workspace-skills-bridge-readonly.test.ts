import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox, withTempDir } from "./fs-bridge.test-helpers.js";
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
    await withTempDir("openclaw-skills-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const skillsWorkspaceDir = path.join(stateDir, "sandbox-state");
      await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".agents", "skills", "demo"), { recursive: true });
      await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });

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

      expect(resolve("normal.txt").writable).toBe(true);
      expect(resolve("skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve(".agents/skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve(".openclaw/sandbox-skills/skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve(".openclaw/sandbox-skills/skills/demo/SKILL.md").hostPath).toBe(
        path.join(skillsWorkspaceDir, "skills", "demo", "SKILL.md"),
      );
      expect(resolve("/workspace/skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve("/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md").writable).toBe(
        false,
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects remote bridge writes under remote-only skill roots",
    async () => {
      await withTempDir("openclaw-skills-remote-only-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const skillsWorkspaceDir = path.join(stateDir, "sandbox-state");
        const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(path.join(remoteWorkspaceDir, "skills", "demo"), { recursive: true });
        await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
        const { bridge, remoteRoot } = await createBridge(
          workspaceDir,
          remoteWorkspaceDir,
          skillsWorkspaceDir,
        );
        await expectWriteRejected(bridge, remoteRoot, "skills/demo/SKILL.md");
        await expectWriteRejected(
          bridge,
          remoteRoot,
          ".openclaw/sandbox-skills/skills/demo/SKILL.md",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects remote bridge mkdirp under skill roots from container cwd",
    async () => {
      await withTempDir("openclaw-skills-remote-cwd-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
        await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
        await fs.mkdir(path.join(remoteWorkspaceDir, "skills", "demo"), { recursive: true });
        const { bridge, remoteRoot } = await createBridge(workspaceDir, remoteWorkspaceDir);

        await expect(
          bridge.mkdirp({ filePath: "skills/demo/generated", cwd: remoteRoot }),
        ).rejects.toThrow(/read-only/);
        await expect(
          fs.stat(path.join(remoteRoot, "skills", "demo", "generated")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});

// Canonical path checks invoke GNU readlink/stat on the local fixture host.
describe.runIf(process.platform === "linux")("workspace skills bridge (GNU shell)", () => {
  it("allows remote bridge writes under absent skill roots", async () => {
    await withTempDir("openclaw-skills-remote-absent-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const { bridge, remoteRoot } = await createBridge(workspaceDir);

      await bridge.writeFile({ filePath: "skills/new.txt", data: "created" });
      await expect(fs.readFile(path.join(remoteRoot, "skills", "new.txt"), "utf8")).resolves.toBe(
        "created",
      );
    });
  });

  it("rejects remote bridge writes through symlinks into skill roots", async () => {
    // Symlink resolution must happen on the remote side too; otherwise writes
    // can bypass read-only skill root detection.
    await withTempDir("openclaw-skills-remote-link-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(path.join(remoteWorkspaceDir, "skills", "demo"), { recursive: true });
      await fs.symlink("skills", path.join(remoteWorkspaceDir, "link"), "dir");
      const { bridge, remoteRoot } = await createBridge(workspaceDir, remoteWorkspaceDir);
      await expectWriteRejected(bridge, remoteRoot, "link/demo/SKILL.md", "skills/demo/SKILL.md");
    });
  });
});
