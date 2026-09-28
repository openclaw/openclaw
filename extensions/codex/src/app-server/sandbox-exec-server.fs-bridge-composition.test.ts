// Exercise RPC authorization against real bridge scripts, symlinks, and filesystem effects.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRemoteShellSandboxFsBridge,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  codexFsSandboxContext,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  rpc,
  specialPath,
} from "./sandbox-exec-server.test-helpers.js";

const SANDBOX_MOUNT = "/workspace";

function rewritePortableStatScript(script: string): string {
  if (process.platform !== "darwin") {
    return script;
  }
  return script
    .replace(
      'LC_ALL=C stat -c "%F|%s|%y" -- "$1"',
      [
        'kind=$(LC_ALL=C stat -f "%HT" -- "$1" | tr "[:upper:]" "[:lower:]")',
        'size=$(LC_ALL=C stat -f "%z" -- "$1")',
        'mtime=$(LC_ALL=C stat -f "%m" -- "$1")',
        'printf "%s|%s|%s\\n" "$kind" "$size" "$mtime"',
      ].join("\n"),
    )
    .replace(
      'stats=$(LC_ALL=C stat -c "%F|%h" -- "$1")',
      [
        'kind=$(LC_ALL=C stat -f "%HT" -- "$1" | tr "[:upper:]" "[:lower:]")',
        'links=$(LC_ALL=C stat -f "%l" -- "$1")',
        'stats="$kind|$links"',
      ].join("\n"),
    );
}

/** Rewrites container paths under SANDBOX_MOUNT onto the real temp workspace. */
function rewriteMountArgs(args: string[] | undefined, mountDir: string): string[] {
  return (args ?? []).map((arg) =>
    arg === SANDBOX_MOUNT || arg.startsWith(`${SANDBOX_MOUNT}/`)
      ? `${mountDir}${arg.slice(SANDBOX_MOUNT.length)}`
      : arg,
  );
}

function runLocalShellScript(
  command: SandboxBackendCommandParams,
  mountDir: string,
): Promise<SandboxBackendCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "sh",
      [
        "-c",
        rewritePortableStatScript(command.script),
        "composition-shell",
        ...rewriteMountArgs(command.args, mountDir),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code: code ?? 0,
      });
    });
    child.stdin?.end(command.stdin);
  });
}

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

describe("sandbox exec-server fs RPC through real bridges", () => {
  it.runIf(process.platform !== "win32")(
    "rejects protected canonical destinations before filesystem effects and lands allowed writes exactly",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-fs-composition-"));
      try {
        const mountDir = path.join(await fs.realpath(stateDir), "workspace");
        await fs.mkdir(mountDir, { recursive: true });
        const gitDir = path.join(mountDir, ".git");
        const realDir = path.join(mountDir, "real");
        await fs.mkdir(gitDir);
        await fs.mkdir(realDir);
        await fs.symlink(gitDir, path.join(mountDir, "alias"));
        await fs.symlink(realDir, path.join(mountDir, "alias-real"));

        const mutationCalls: SandboxBackendCommandParams[] = [];
        const runtime = {
          remoteWorkspaceDir: SANDBOX_MOUNT,
          remoteAgentWorkspaceDir: SANDBOX_MOUNT,
          runRemoteShellScript: async (command: SandboxBackendCommandParams) => {
            if (command.script.includes("operation = sys.argv[1]")) {
              mutationCalls.push(command);
            }
            return await runLocalShellScript(command, mountDir);
          },
        };
        const realBridge = createRemoteShellSandboxFsBridge({
          sandbox: {
            workspaceDir: mountDir,
            agentWorkspaceDir: mountDir,
            workspaceAccess: "rw",
          } as never,
          runtime: runtime as never,
        });
        const sandbox = {
          ...createSandboxContext({
            runShellCommand: async (command) => await runLocalShellScript(command, mountDir),
          }),
          fsBridge: realBridge,
        };

        const client = createClient();
        await ensureCodexSandboxExecServerEnvironment({
          client: client as never,
          sandbox: sandbox as never,
        });
        const socket = await openSocket(execServerUrlFromClient(client));
        await rpc(socket, "initialize", { clientName: "test" });
        socket.send(JSON.stringify({ method: "initialized" }));
        const workspacePolicy = codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: specialPath("project_roots"), access: "write" },
            { path: specialPath("project_roots", ".git"), access: "read" },
          ],
        });

        await expect(
          rpc(socket, "fs/writeFile", {
            path: "file:///workspace/alias/config",
            dataBase64: Buffer.from("blocked").toString("base64"),
            sandbox: workspacePolicy,
          }),
        ).rejects.toThrow("Codex fs sandbox denied write access");
        await expect(fs.stat(path.join(gitDir, "config"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(mutationCalls).toHaveLength(0);

        await rpc(socket, "fs/writeFile", {
          path: "file:///workspace/real-note.txt",
          dataBase64: Buffer.from("allowed").toString("base64"),
          sandbox: workspacePolicy,
        });
        await expect(fs.readFile(path.join(mountDir, "real-note.txt"), "utf8")).resolves.toBe(
          "allowed",
        );
        expect(mutationCalls.length).toBeGreaterThan(0);

        await rpc(socket, "fs/writeFile", {
          path: "file:///workspace/alias-real/config",
          dataBase64: Buffer.from("aliased").toString("base64"),
          sandbox: workspacePolicy,
        });
        await expect(fs.readFile(path.join(realDir, "config"), "utf8")).resolves.toBe("aliased");

        // Existing directory roots must resolve as directories, not file-backed parents.
        await fs.mkdir(path.join(mountDir, "nested", "src-dir"), { recursive: true });
        await fs.writeFile(path.join(mountDir, "nested", "src-dir", "child.txt"), "dir-copy");
        await rpc(socket, "fs/copy", {
          sourcePath: "file:///workspace/nested/src-dir",
          destinationPath: "file:///workspace",
          recursive: true,
          sandbox: workspacePolicy,
        });
        await expect(fs.readFile(path.join(mountDir, "child.txt"), "utf8")).resolves.toBe(
          "dir-copy",
        );

        // An alias must not hide a copy into the source subtree.
        const sourceSubdir = path.join(mountDir, "nested", "src-dir", "subdir");
        await fs.mkdir(sourceSubdir);
        await fs.symlink(sourceSubdir, path.join(mountDir, "source-subdir-alias"));
        const mutationsBeforeRejectedCopy = mutationCalls.length;
        await expect(
          rpc(socket, "fs/copy", {
            sourcePath: "file:///workspace/nested/src-dir",
            destinationPath: "file:///workspace/source-subdir-alias",
            recursive: true,
            sandbox: workspacePolicy,
          }),
        ).rejects.toThrow("Cannot recursively copy a directory into itself");
        expect(mutationCalls).toHaveLength(mutationsBeforeRejectedCopy);
        await expect(fs.stat(path.join(sourceSubdir, "child.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        // A directory alias must pin the target directory itself.
        const dirTarget = path.join(mountDir, "dir-target");
        await fs.mkdir(dirTarget, { recursive: true });
        await fs.symlink(dirTarget, path.join(mountDir, "alias-dir"));
        await rpc(socket, "fs/copy", {
          sourcePath: "file:///workspace/nested/src-dir",
          destinationPath: "file:///workspace/alias-dir",
          recursive: true,
          sandbox: workspacePolicy,
        });
        await expect(fs.readFile(path.join(dirTarget, "child.txt"), "utf8")).resolves.toBe(
          "dir-copy",
        );
        socket.close();
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
