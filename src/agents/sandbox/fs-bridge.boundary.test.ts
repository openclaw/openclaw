// Sandbox filesystem bridge boundary tests cover host-side validation before
// any Docker filesystem command can run.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_STAT_PARENT_NOT_FOUND_EXIT_CODE } from "./fs-bridge-shell-command-plans.js";
import {
  createHostEscapeFixture,
  createSandbox,
  createSandboxFsBridge,
  dockerExecResult,
  expectMkdirpAllowsExistingDirectory,
  findCallByDockerArg,
  findCallByScriptFragment,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge boundary validation", () => {
  installFsBridgeTestHarness();

  it("blocks writes into read-only bind mounts", async () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const bridge = createSandboxFsBridge({ sandbox });

    await expect(
      bridge.writeFile({ filePath: "/workspace-two/new.txt", data: "hello" }),
    ).rejects.toThrow(/read-only/);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });

  it("allows mkdirp for existing in-boundary subdirectories", async () => {
    await expectMkdirpAllowsExistingDirectory();
  });

  it("allows mkdirp when boundary open reports io for an existing directory", async () => {
    await expectMkdirpAllowsExistingDirectory({ forceBoundaryIoFallback: true });
  });

  it("rejects mkdirp when target exists as a file", async () => {
    await withTempDir("openclaw-fs-bridge-mkdirp-file-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const filePath = path.join(workspaceDir, "memory", "kemik");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not a directory");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.mkdirp({ filePath: "memory/kemik" })).rejects.toThrow(
        /cannot create directories/i,
      );
      expect(findCallByDockerArg(1, "mkdirp")).toBeUndefined();
    });
  });

  it("rejects pre-existing host symlink escapes before docker exec", async () => {
    // Host-visible symlink escapes are rejected locally so Docker never follows
    // them inside a privileged bridge command.
    await withTempDir("openclaw-fs-bridge-", async (stateDir) => {
      const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
      if (process.platform === "win32") {
        return;
      }
      await fs.symlink(outsideFile, path.join(workspaceDir, "link.txt"));

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(/Symlink escapes/);
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects pre-existing host hardlink escapes before docker exec", async () => {
    // Hardlinks can expose outside files without a symlink marker, so the bridge
    // checks link metadata before reads enter the container.
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-fs-bridge-hardlink-", async (stateDir) => {
      const { workspaceDir, outsideFile } = await createHostEscapeFixture(stateDir);
      const hardlinkPath = path.join(workspaceDir, "link.txt");
      try {
        await fs.link(outsideFile, hardlinkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(/hardlink|sandbox/i);
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects missing files before any docker read command runs", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.readFile({ filePath: "a.txt" })).rejects.toThrow(/ENOENT|no such file/i);
    expect(mockedExecDockerRaw).not.toHaveBeenCalled();
  });

  // Stat must work for every existing in-mount path shape the Codex sandbox
  // exec-server probes: the mount root itself, directories, and paths whose
  // parents do not exist yet. Regressions here break native apply_patch
  // writes, which pre-check the target's parent directory through stat.
  it("stats the workspace mount root instead of escaping to its parent", async () => {
    await withTempDir("openclaw-fs-bridge-root-stat-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });

      await expect(bridge.stat({ filePath: "/workspace" })).resolves.not.toBeNull();

      const statCall = findCallByScriptFragment('stat -c "%F|%s|%y"');
      if (!statCall) {
        throw new Error("expected docker stat call");
      }
      // Anchored at the mount root itself; its parent lives outside the mounts.
      expect(getDockerArg(statCall[0], 1)).toBe("/workspace");
      expect(getDockerArg(statCall[0], 2)).toBe(".");
    });
  });

  it("stats an existing directory target", async () => {
    await withTempDir("openclaw-fs-bridge-dir-stat-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });

      await expect(bridge.stat({ filePath: "subdir" })).resolves.not.toBeNull();
    });
  });

  it("returns null instead of throwing when intermediate directories are missing", async () => {
    await withTempDir("openclaw-fs-bridge-missing-parent-stat-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
      });
      mockedExecDockerRaw.mockImplementation(async (args) => {
        const script = getDockerScript(args);
        if (script.includes('readlink -f -- "$cursor"')) {
          return dockerExecResult(`${getDockerArg(args, 1)}\n`);
        }
        if (script.includes('stat -c "%F|%s|%y"')) {
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            code: SANDBOX_STAT_PARENT_NOT_FOUND_EXIT_CODE,
          };
        }
        return dockerExecResult("");
      });

      // A missing-parent stat is a not-found result, not a bridge failure;
      // writers rely on the not-found signal to create parent directories.
      await expect(bridge.stat({ filePath: "ghost/sub/file.txt" })).resolves.toBeNull();
    });
  });
});
