import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveRootPath } from "../../infra/boundary-path.js";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import { buildRemoteCommand } from "./ssh.js";

export type UserSandboxSettings = {
  command: string;
  username: string;
};

export type RunUserSandboxCommandParams = {
  settings: UserSandboxSettings;
  remoteCommand: string;
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

function buildUserFailureMessage(stderr: string, exitCode?: number): string {
  const trimmed = stderr.trim();
  return (
    trimmed ||
    (exitCode !== undefined
      ? `su exited with code ${exitCode}`
      : "su exited with a non-zero status")
  );
}

export function buildUserSandboxArgv(params: {
  settings: UserSandboxSettings;
  remoteCommand: string;
}): string[] {
  return [params.settings.command, params.settings.username, "-c", params.remoteCommand];
}

export async function runUserSandboxCommand(
  params: RunUserSandboxCommandParams,
): Promise<SandboxBackendCommandResult> {
  const argv = buildUserSandboxArgv({
    settings: params.settings,
    remoteCommand: params.remoteCommand,
  });
  const suEnv = sanitizeEnvVars(process.env).allowed;
  return await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: suEnv,
      signal: params.signal,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !params.allowFailure) {
        reject(
          Object.assign(new Error(buildUserFailureMessage(stderr.toString("utf8"), exitCode)), {
            code: exitCode,
            stdout,
            stderr,
          }),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    if (params.stdin !== undefined) {
      child.stdin.end(params.stdin);
      return;
    }
    child.stdin.end();
  });
}

export async function resolveUserSandboxHome(settings: UserSandboxSettings): Promise<string> {
  const result = await runUserSandboxCommand({
    settings,
    remoteCommand: buildRemoteCommand([
      "/bin/sh",
      "-c",
      'home=${HOME:-}; if [ -n "$home" ]; then printf "%s\\n" "$home"; else getent passwd "$(id -un)" | cut -d: -f6; fi',
      "openclaw-user-home",
    ]),
  });
  const home = result.stdout.toString("utf8").trim();
  if (!home) {
    throw new Error(`Failed to resolve home directory for sandbox user "${settings.username}".`);
  }
  return home;
}

export async function uploadDirectoryToUserTarget(params: {
  settings: UserSandboxSettings;
  localDir: string;
  targetDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  await assertSafeUploadSymlinks(params.localDir);
  const remoteCommand = buildRemoteCommand([
    "/bin/sh",
    "-c",
    'mkdir -p -- "$1" && tar -xf - -C "$1"',
    "openclaw-user-upload",
    params.targetDir,
  ]);
  const suArgv = buildUserSandboxArgv({
    settings: params.settings,
    remoteCommand,
  });
  const suEnv = sanitizeEnvVars(process.env).allowed;
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: params.signal,
    });
    const su = spawn(suArgv[0], suArgv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: suEnv,
      signal: params.signal,
    });
    const tarStderr: Buffer[] = [];
    const suStdout: Buffer[] = [];
    const suStderr: Buffer[] = [];
    let tarClosed = false;
    let suClosed = false;
    let tarCode = 0;
    let suCode = 0;

    tar.stderr.on("data", (chunk) => tarStderr.push(Buffer.from(chunk)));
    su.stdout.on("data", (chunk) => suStdout.push(Buffer.from(chunk)));
    su.stderr.on("data", (chunk) => suStderr.push(Buffer.from(chunk)));

    const fail = (error: unknown) => {
      tar.kill("SIGKILL");
      su.kill("SIGKILL");
      reject(error);
    };

    tar.on("error", fail);
    su.on("error", fail);
    tar.stdout.pipe(su.stdin);

    tar.on("close", (code) => {
      tarClosed = true;
      tarCode = code ?? 0;
      maybeResolve();
    });
    su.on("close", (code) => {
      suClosed = true;
      suCode = code ?? 0;
      maybeResolve();
    });

    function maybeResolve() {
      if (!tarClosed || !suClosed) {
        return;
      }
      if (tarCode !== 0) {
        reject(
          new Error(
            Buffer.concat(tarStderr).toString("utf8").trim() || `tar exited with code ${tarCode}`,
          ),
        );
        return;
      }
      if (suCode !== 0) {
        reject(
          new Error(
            Buffer.concat(suStderr).toString("utf8").trim() || `su exited with code ${suCode}`,
          ),
        );
        return;
      }
      resolve();
    }
  });
}

async function assertSafeUploadSymlinks(localDir: string): Promise<void> {
  const rootDir = path.resolve(localDir);
  await walkDirectory(rootDir);

  async function walkDirectory(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          await resolveRootPath({
            absolutePath: entryPath,
            rootPath: rootDir,
            boundaryLabel: "user sandbox upload tree",
          });
        } catch (error) {
          const relativePath = path.relative(rootDir, entryPath).split(path.sep).join("/");
          throw new Error(
            `User sandbox upload refuses symlink escaping the workspace: ${relativePath}`,
            {
              cause: error,
            },
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walkDirectory(entryPath);
      }
    }
  }
}
