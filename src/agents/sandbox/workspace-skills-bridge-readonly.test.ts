import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import { createSandbox, withTempDir } from "./fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";

describe("workspace skills bridge mount policy", () => {
  it("resolves workspace skill roots as read-only", async () => {
    await withTempDir("openclaw-skills-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".agents", "skills", "demo"), { recursive: true });

      const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
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
      expect(resolve("/workspace/skills/demo/SKILL.md").writable).toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")(
    "allows remote bridge writes under absent skill roots",
    async () => {
      await withTempDir("openclaw-skills-remote-absent-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });

        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
          runtime: {
            remoteWorkspaceDir: workspaceDir,
            remoteAgentWorkspaceDir: workspaceDir,
            runRemoteShellScript: async (command) => {
              const result = command.script.includes('python3 /dev/fd/3 "$@" 3<<')
                ? spawnSync(
                    "python3",
                    ["-c", SANDBOX_PINNED_MUTATION_PYTHON, ...(command.args ?? [])],
                    {
                      input: command.stdin,
                      encoding: "buffer",
                      stdio: ["pipe", "pipe", "pipe"],
                    },
                  )
                : spawnSync("sh", ["-c", command.script, "openclaw-test", ...(command.args ?? [])], {
                    input: command.stdin,
                    encoding: "buffer",
                    stdio: ["pipe", "pipe", "pipe"],
                  });
              const stdout = Buffer.isBuffer(result.stdout)
                ? result.stdout
                : Buffer.from(result.stdout ?? []);
              const stderr = Buffer.isBuffer(result.stderr)
                ? result.stderr
                : Buffer.from(result.stderr ?? []);
              const code = result.status ?? (result.signal ? 128 : 1);
              if (result.error) {
                throw result.error;
              }
              if (code !== 0 && !command.allowFailure) {
                throw Object.assign(
                  new Error(stderr.toString("utf8").trim() || `shell exited with code ${code}`),
                  { code, stdout, stderr },
                );
              }
              return { stdout, stderr, code };
            },
          },
        });

        await bridge.writeFile({ filePath: "skills/new.txt", data: "created" });
        await expect(fs.readFile(path.join(workspaceDir, "skills", "new.txt"), "utf8")).resolves.toBe(
          "created",
        );
      });
    },
  );
});
