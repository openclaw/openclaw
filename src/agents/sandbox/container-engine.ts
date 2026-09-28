/**
 * Shared local container-engine process execution and backend selection.
 */
import { createAbortError } from "../../infra/abort-signal.js";
import { toErrorObject } from "../../infra/errors.js";
import { isPlainCommandExitFailure, spawnCommand } from "../../process/exec.js";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

export type ExecContainerRawOptions = {
  allowFailure?: boolean;
  input?: Buffer | string;
  signal?: AbortSignal;
};

export type SandboxContainerEngine = {
  id: "docker" | "podman";
  command: "docker" | "podman";
  displayName: "Docker" | "Podman";
  globalArgs?: readonly string[];
};

export type SandboxContainerEngineTarget = {
  key: string;
  globalArgs: string[];
};

export const DOCKER_SANDBOX_ENGINE: SandboxContainerEngine = {
  id: "docker",
  command: "docker",
  displayName: "Docker",
};

export const PODMAN_SANDBOX_ENGINE: SandboxContainerEngine = {
  id: "podman",
  command: "podman",
  displayName: "Podman",
};

export type ExecDockerRawResult = SandboxBackendCommandResult;

function missingContainerEngineMessage(engine: SandboxContainerEngine): string {
  if (engine.id === "docker") {
    return 'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.';
  }
  return 'Sandbox mode requires Podman, but the "podman" command was not found in PATH. Install Podman (and ensure "podman" is available), choose another sandbox backend, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.';
}

export async function execContainerRaw(
  engine: SandboxContainerEngine,
  args: string[],
  opts?: ExecContainerRawOptions,
): Promise<ExecDockerRawResult> {
  let result;
  try {
    result = await spawnCommand([engine.command, ...(engine.globalArgs ?? []), ...args], {
      cancelSignal: opts?.signal,
      encoding: "buffer",
      input: opts?.input ?? Buffer.alloc(0),
      maxBuffer: SANDBOX_COMMAND_MAX_BUFFER_BYTES,
      reject: false,
      stripFinalNewline: false,
    });
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw createAbortError("Aborted");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(missingContainerEngineMessage(engine)), {
        code: "INVALID_CONFIG",
        cause: error,
      });
    }
    throw error;
  }
  if (opts?.signal?.aborted || result.isCanceled) {
    throw createAbortError("Aborted");
  }
  if (result.failed && !isPlainCommandExitFailure(result)) {
    if (result.code === "ENOENT") {
      throw Object.assign(new Error(missingContainerEngineMessage(engine)), {
        code: "INVALID_CONFIG",
        cause: result,
      });
    }
    throw toErrorObject(result, `${engine.displayName} command execution failed`);
  }
  const stdout = Buffer.from(result.stdout);
  const stderr = Buffer.from(result.stderr);
  const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
  if (exitCode !== 0 && !opts?.allowFailure) {
    let message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
    if (
      engine.id === "podman" &&
      args[0] === "create" &&
      /^(?:Error: )?(?:lookup init binary|container-init binary not found on the host):/mu.test(
        message,
      )
    ) {
      // Podman owns init resolution, including helpers outside PATH and inside Podman Machine.
      message +=
        "\nInstall catatonit on the Podman engine host, or repair its configured init_path/helper_binaries_dir in containers.conf, then retry. The init executable must be available to the engine, not only inside the sandbox image. Keep --init and sandboxing enabled so orphaned processes are reaped.";
    }
    throw Object.assign(
      new Error(message || `${engine.displayName} command failed (exit ${exitCode})`),
      { code: exitCode, stdout, stderr },
    );
  }
  return { stdout, stderr, code: exitCode };
}

export async function execContainer(
  engine: SandboxContainerEngine,
  args: string[],
  opts?: ExecContainerRawOptions,
) {
  const result = await execContainerRaw(engine, args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}
