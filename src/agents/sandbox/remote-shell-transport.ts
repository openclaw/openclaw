/** Remote-shell transport operations shared by SSH and provider-owned execution. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveRootPath } from "../../infra/boundary-path.js";
import { toErrorObject } from "../../infra/errors.js";
import { normalizeEnvVarKey } from "../../infra/host-env-security.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../../process/exec-output.js";
import { isPlainCommandExitFailure, spawnCommand } from "../../process/exec.js";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
import {
  SANDBOX_COMMAND_MAX_BUFFER_BYTES,
  SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES,
} from "./constants.js";
import {
  buildRemoteCommand,
  shellEscape,
  ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT,
} from "./remote-shell-command.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";

export type RemoteShellCommandSpec = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Local transport cwd; independent of the remote command's workdir. */
  cwd?: string;
};
type RemoteShellRunParams = {
  remoteCommand: string;
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
  tty?: boolean;
};
type RemoteShellUploadParams = {
  localDir: string;
  remoteDir: string;
  remoteRootDir?: string;
  signal?: AbortSignal;
};
type RemoteShellExecParams = {
  remoteCommand: string;
  env: Record<string, string>;
  tty?: boolean;
};
export type RemoteShellSandboxSession = {
  runCommand(params: RemoteShellRunParams): Promise<SandboxBackendCommandResult>;
  uploadDirectory(params: RemoteShellUploadParams): Promise<void>;
  prepareExec(
    params: RemoteShellExecParams,
  ): Promise<RemoteShellCommandSpec & { cleanup: () => Promise<void> }>;
  dispose(): Promise<void>;
};
export type RemoteShellSessionOptions = {
  buildCommand(params: { remoteCommand: string; tty?: boolean }): RemoteShellCommandSpec;
  assertCurrent?: () => void;
  dispose?: () => Promise<void>;
  formatFailure?: (stderr: string, exitCode: number) => string;
};

/** Build all remote I/O from one provider-owned local command boundary. */
export function createRemoteShellSandboxSession(
  options: RemoteShellSessionOptions,
): RemoteShellSandboxSession {
  const runCommand = async (
    params: RemoteShellRunParams,
    checkCurrent = true,
  ): Promise<SandboxBackendCommandResult> => {
    const command = options.buildCommand(params);
    if (command.argv.length === 0) {
      throw new Error("Remote shell command argv is empty");
    }
    if (checkCurrent) {
      options.assertCurrent?.();
    }
    params.signal?.throwIfAborted();
    const result = await spawnCommand(command.argv, {
      baseEnv: command.env,
      cwd: command.cwd,
      cancelSignal: params.signal,
      encoding: "buffer",
      input: params.stdin ?? Buffer.alloc(0),
      maxBuffer: SANDBOX_COMMAND_MAX_BUFFER_BYTES,
      reject: false,
      stripFinalNewline: false,
    });
    if (params.signal?.aborted || result.isCanceled) {
      throw createAbortError("Aborted");
    }
    if (result.failed && !isPlainCommandExitFailure(result)) {
      throw toErrorObject(result, "Remote shell command execution failed");
    }
    const stdout = Buffer.from(result.stdout);
    const stderr = Buffer.from(result.stderr);
    const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
    if (exitCode !== 0 && !params.allowFailure) {
      const message =
        options.formatFailure?.(stderr.toString("utf8"), exitCode) ??
        (stderr.toString("utf8").trim() || `remote shell exited with code ${exitCode}`);
      throw Object.assign(new Error(message), { code: exitCode, stdout, stderr });
    }
    return { stdout, stderr, code: exitCode };
  };
  return {
    runCommand,
    uploadDirectory: (params) => uploadDirectoryToRemoteCommand(params, options),
    prepareExec: (params) => prepareRemoteShellExec(params, options, runCommand),
    dispose: options.dispose ?? (async () => {}),
  };
}

async function prepareRemoteShellExec(
  params: RemoteShellExecParams,
  options: RemoteShellSessionOptions,
  runCommand: (
    params: RemoteShellRunParams,
    checkCurrent?: boolean,
  ) => Promise<SandboxBackendCommandResult>,
): Promise<RemoteShellCommandSpec & { cleanup: () => Promise<void> }> {
  const env =
    params.tty && params.env.TERM === undefined
      ? { TERM: "xterm-256color", ...params.env }
      : params.env;
  for (const [key, value] of Object.entries(env)) {
    if (normalizeEnvVarKey(key, { portable: true }) !== key) {
      throw new Error(
        `Invalid sandbox environment variable name ${JSON.stringify(key)}; use a POSIX variable name.`,
      );
    }
    if (value.includes("\0")) {
      throw new Error(
        `Invalid sandbox environment variable ${JSON.stringify(key)}; values must not contain NUL bytes.`,
      );
    }
  }
  const remoteDir = `/tmp/openclaw-sandbox-exec-${randomUUID()}`;
  const remoteScript = `${remoteDir}/exec.sh`;
  const script = [
    "#!/bin/sh",
    "set -e",
    `rm -rf -- ${shellEscape(remoteDir)}`,
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellEscape(value)}`),
    `exec ${params.remoteCommand}`,
    "",
  ].join("\n");
  const cleanup = async () => {
    // Cleanup owns this exact staged artifact even after core runtime revocation.
    // The provider command still enforces its own current claim authority.
    await runCommand(
      {
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'rm -rf -- "$1"',
          "openclaw-sandbox-exec-cleanup",
          remoteDir,
        ]),
        allowFailure: true,
      },
      false,
    );
  };
  try {
    await runCommand({
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'umask 077 && mkdir -- "$1" && cat > "$1/exec.sh" && chmod 700 "$1/exec.sh"',
        "openclaw-sandbox-exec-stage",
        remoteDir,
      ]),
      stdin: script,
    });
    return {
      ...options.buildCommand({
        remoteCommand: buildRemoteCommand(["/bin/sh", remoteScript]),
        tty: params.tty,
      }),
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

async function uploadDirectoryToRemoteCommand(
  params: RemoteShellUploadParams,
  options: RemoteShellSessionOptions,
): Promise<void> {
  await assertSafeUploadSymlinks(params.localDir, params.signal);
  const remoteCommand = buildRemoteCommand([
    "/bin/sh",
    "-c",
    `${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\ntar -xf - -C "$1"`,
    "openclaw-sandbox-upload",
    params.remoteDir,
    params.remoteRootDir ?? params.remoteDir,
  ]);
  const command = options.buildCommand({ remoteCommand });
  const [executable, ...args] = command.argv;
  if (!executable) {
    throw new Error("Remote shell command argv is empty");
  }
  const tarEnv = sanitizeEnvVars(process.env).allowed;
  await new Promise<void>((resolve, reject) => {
    options.assertCurrent?.();
    params.signal?.throwIfAborted();
    const tar: ChildProcess = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
      env: tarEnv,
      signal: params.signal,
    });
    const remote: ChildProcess = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env,
      cwd: command.cwd,
      signal: params.signal,
    });
    // Diagnostics are retained only to explain a failed transfer, so keep a
    // bounded tail instead of every chunk. `remoteStdout` carries the mirrored
    // tar archive on its way to the remote `tar -xf`; nothing reads it, so
    // count it without retaining a second copy in the parent heap.
    const tarStderr = createCapturedOutputBuffers();
    const remoteStdout = createCapturedOutputBuffers();
    const remoteStderr = createCapturedOutputBuffers();
    let tarClosed = false;
    let remoteClosed = false;
    let tarCode: number | null = 0;
    let remoteCode: number | null = 0;
    let tarSignal: NodeJS.Signals | null = null;
    let remoteSignal: NodeJS.Signals | null = null;
    let failure: Error | undefined;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled || failure) {
        return;
      }
      // Abort and stream errors can precede close; cleanup must still join both children.
      failure = toErrorObject(error, "Non-Error rejection");
      for (const child of [tar, remote]) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Preserve the pipeline error while still terminating the peer.
        }
      }
      maybeResolve();
    };

    tar.on("error", fail);
    remote.on("error", fail);

    tar.on("close", (code, signal) => {
      tarClosed = true;
      tarCode = code;
      tarSignal = signal;
      maybeResolve();
    });
    remote.on("close", (code, signal) => {
      remoteClosed = true;
      remoteCode = code;
      remoteSignal = signal;
      maybeResolve();
    });

    // EMFILE/ENFILE can leave streams absent; native error and close still settle the child.
    tar.stderr?.on("data", (chunk) =>
      appendCapturedOutput(
        tarStderr,
        Buffer.from(chunk),
        SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES,
        "tail",
      ),
    );
    tar.stderr?.on("error", fail);
    tar.stdout?.on("error", fail);
    remote.stdout?.on("data", (chunk) =>
      appendCapturedOutput(remoteStdout, Buffer.from(chunk), 0, "discard"),
    );
    remote.stdout?.on("error", fail);
    remote.stderr?.on("data", (chunk) =>
      appendCapturedOutput(
        remoteStderr,
        Buffer.from(chunk),
        SANDBOX_UPLOAD_DIAGNOSTIC_TAIL_BYTES,
        "tail",
      ),
    );
    remote.stderr?.on("error", fail);
    remote.stdin?.on("error", fail);

    function maybeResolve() {
      if (settled || !tarClosed || !remoteClosed) {
        return;
      }
      settled = true;
      if (failure) {
        reject(failure);
        return;
      }
      // Render the retained tail once, and name the truncation so a clipped
      // diagnostic is not mistaken for the remote side's complete complaint.
      const tarStderrText = renderUploadDiagnostic(
        tarStderr,
        "tail",
        `tar exited with code ${tarCode}`,
      );
      const remoteStderrText = renderUploadDiagnostic(
        remoteStderr,
        "tail",
        `remote exited with code ${remoteCode}`,
      );
      // A null code means the process died from a signal (OOM kill, dropped
      // connection, supervisor teardown) without reporting a status. An
      // unknown outcome is not evidence of a completed transfer.
      if (tarCode === null) {
        reject(new Error(`tar exited from signal ${tarSignal ?? "unknown"}`));
        return;
      }
      if (tarCode !== 0) {
        reject(new Error(tarStderrText));
        return;
      }
      if (remoteCode === null) {
        reject(new Error(`remote exited from signal ${remoteSignal ?? "unknown"}`));
        return;
      }
      if (remoteCode !== 0) {
        reject(new Error(remoteStderrText));
        return;
      }
      resolve();
    }

    try {
      // Readable pipe errors do not close the writable peer automatically.
      if (tar.stdout && remote.stdin) {
        tar.stdout.pipe(remote.stdin);
      }
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Render a bounded upload diagnostic for an error message.
 *
 * The retained tail is not the whole story once the bound is reached, so say so
 * explicitly rather than letting a clipped tail read as the complete failure.
 */
function renderUploadDiagnostic(
  capture: ReturnType<typeof createCapturedOutputBuffers>,
  mode: "head" | "tail" | "discard",
  fallback: string,
): string {
  const text = finalizeCapturedOutput(capture, mode).toString("utf8").trim();
  if (!text) {
    return fallback;
  }
  return capture.truncatedBytes > 0
    ? `${text}\n(truncated; dropped ${capture.truncatedBytes} earlier bytes of remote diagnostics)`
    : text;
}

async function assertSafeUploadSymlinks(localDir: string, signal?: AbortSignal): Promise<void> {
  const rootDir = path.resolve(localDir);
  await walkDirectory(rootDir);

  async function walkDirectory(currentDir: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        // The remote tar extract should not recreate links that escape the
        // uploaded workspace tree.
        try {
          await resolveRootPath({
            absolutePath: entryPath,
            rootPath: rootDir,
            boundaryLabel: "Remote sandbox upload tree",
          });
        } catch (error) {
          const relativePath = path.relative(rootDir, entryPath).split(path.sep).join("/");
          throw new Error(
            `Remote sandbox upload refuses symlink escaping the workspace: ${relativePath}`,
            { cause: error },
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
