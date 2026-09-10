// RPC-to-bridge composition tests drive the sandbox exec-server filesystem RPC
// through a real bridge implementation (real shell execution, real symlinks)
// and verify authorization decisions against observed filesystem effects:
// protected canonical destinations are rejected before any mutation runs, and
// allowed writes land exactly on the authorized canonical destination.
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

type RemoteShellCommand = SandboxBackendCommandParams;

/** Rewrites container paths under SANDBOX_MOUNT onto the real temp workspace. */
function rewriteMountArgs(args: string[] | undefined, mountDir: string): string[] {
  return (args ?? []).map((arg) =>
    arg === SANDBOX_MOUNT || arg.startsWith(`${SANDBOX_MOUNT}/`)
      ? `${mountDir}${arg.slice(SANDBOX_MOUNT.length)}`
      : arg,
  );
}

/** Spawns the exact shell script locally with rewritten sandbox paths. */
function runLocalShellScript(
  command: RemoteShellCommand,
  mountDir: string,
): Promise<SandboxBackendCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "sh",
      ["-c", command.script, "composition-shell", ...rewriteMountArgs(command.args, mountDir)],
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

/**
 * Real sandbox backend for the composition harness: backend commands (such as
 * the directory listing used by recursive copies) execute for real against
 * the temp workspace with rewritten sandbox paths.
 */
function createLocalExecBackend(mountDir: string) {
  return {
    id: "local-composition",
    runtimeId: "codex-fs-composition",
    runtimeLabel: "codex-fs-composition",
    workdir: mountDir,
    buildExecSpec: async ({
      command,
      env,
    }: {
      command: string;
      env: Record<string, string | undefined>;
    }) => ({
      argv: ["sh", "-c", command],
      env,
      stdinMode: "pipe-closed" as const,
    }),
    runShellCommand: async (command: RemoteShellCommand) =>
      await runLocalShellScript(command, mountDir),
  };
}

/**
 * Executes remote shell snippets locally so the bridge scripts run for real
 * against a temp workspace. The bridge speaks container paths under
 * SANDBOX_MOUNT; the shim rewrites those argv paths onto the temp workspace.
 */
function createLocalShellRemoteRuntime(remoteMountDir: string) {
  const mutationCalls: RemoteShellCommand[] = [];
  const runtime = {
    remoteWorkspaceDir: SANDBOX_MOUNT,
    remoteAgentWorkspaceDir: SANDBOX_MOUNT,
    runRemoteShellScript: async (command: RemoteShellCommand) => {
      if (command.script.includes("operation = sys.argv[1]")) {
        mutationCalls.push(command);
      }
      return await runLocalShellScript(command, remoteMountDir);
    },
  };
  return { mutationCalls, runtime };
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
        // A workspace alias that canonicalizes into the protected .git
        // directory, and one that canonicalizes into a writable directory.
        await fs.symlink(gitDir, path.join(mountDir, "alias"));
        await fs.symlink(realDir, path.join(mountDir, "alias-real"));

        const { mutationCalls, runtime } = createLocalShellRemoteRuntime(mountDir);
        const realBridge = createRemoteShellSandboxFsBridge({
          sandbox: {
            workspaceDir: mountDir,
            agentWorkspaceDir: mountDir,
            workspaceAccess: "rw",
          } as never,
          runtime: runtime as never,
        });
        const sandbox = {
          ...createSandboxContext({}),
          backend: createLocalExecBackend(mountDir),
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

        // Protected canonical destination: denied before any filesystem effect.
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
        // The real bridge never received a mutation for the denied request.
        expect(mutationCalls).toHaveLength(0);

        // Allowed direct write lands on the authorized destination.
        await rpc(socket, "fs/writeFile", {
          path: "file:///workspace/real-note.txt",
          dataBase64: Buffer.from("allowed").toString("base64"),
          sandbox: workspacePolicy,
        });
        await expect(fs.readFile(path.join(mountDir, "real-note.txt"), "utf8")).resolves.toBe(
          "allowed",
        );
        expect(mutationCalls.length).toBeGreaterThan(0);

        // Allowed aliased write pins the canonical destination: the payload
        // lands on the alias target, not on the lexical request path.
        await rpc(socket, "fs/writeFile", {
          path: "file:///workspace/alias-real/config",
          dataBase64: Buffer.from("aliased").toString("base64"),
          sandbox: workspacePolicy,
        });
        await expect(fs.readFile(path.join(realDir, "config"), "utf8")).resolves.toBe("aliased");

        // Recursive directory copy into the existing mount root: directory
        // destinations resolve with directory semantics (the root itself), so
        // the copy reaches the existing-root path instead of being rejected
        // by file-backed parent resolution. Directory copies place the source
        // children inside the destination.
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

        // A destination alias into the canonical source subtree is rejected
        // before mkdirp or any child copy can mutate the destination.
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

        // Recursive directory copy into an existing directory alias: the
        // directory pin follows the canonical directory, so children land in
        // the alias target.
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
