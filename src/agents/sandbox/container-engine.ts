/**
 * Shared local container-engine process execution and backend selection.
 */
import { createAbortError } from "../../infra/abort-signal.js";
import { toErrorObject } from "../../infra/errors.js";
import { resolveExecutableFromPathEnv } from "../../infra/executable-path.js";
import {
  runOutsideCommandProcessScope,
  withCommandProcessScope,
} from "../../process/exec-spawn.js";
import { isPlainCommandExitFailure, spawnCommand } from "../../process/exec.js";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

// Cleanup has its own bounded process scope, independent of revoked turn authority.
const NATIVE_SANDBOX_SETTLEMENT_MS = 30_000;

const nativeBinding = Symbol("native sandbox transport");
type NativeBinding = {
  executable: string;
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  target?: Readonly<{ key: string; globalArgs: readonly string[] }>;
};
type BoundEngine = SandboxContainerEngine & { [nativeBinding]: NativeBinding };

function isBoundEngine(engine: SandboxContainerEngine): engine is BoundEngine {
  return nativeBinding in engine;
}

/** Restart recovery can only retire recorded resources, never launch new work. */
export function captureNativeSandboxCleanupEngine(
  engine: SandboxContainerEngine,
): SandboxContainerEngine {
  const cwd = process.cwd();
  const env = Object.freeze({ ...process.env });
  const executable = resolveExecutableFromPathEnv(engine.command, env.PATH ?? "", env, {
    cwd,
    useCache: false,
  });
  if (!executable) {
    throw new Error("Native sandbox executable could not be captured.");
  }
  return Object.freeze({
    ...engine,
    globalArgs: Object.freeze([...(engine.globalArgs ?? [])]),
    [nativeBinding]: Object.freeze({ executable, cwd, env }),
  });
}

export function bindNativeSandboxEngineTarget(
  engine: SandboxContainerEngine,
  target: SandboxContainerEngineTarget,
): SandboxContainerEngine {
  if (!isBoundEngine(engine)) {
    throw new Error("Native sandbox transport is not captured.");
  }
  const flag = engine.id === "docker" ? "--host" : "--url";
  if (
    !(engine.id === "podman" && target.key === "local" && target.globalArgs.length === 0) &&
    (target.globalArgs.length !== 2 ||
      target.globalArgs[0] !== flag ||
      !target.globalArgs[1]?.startsWith("unix:///"))
  ) {
    throw new Error(
      "Foreground sandbox requires local Podman or a captured Unix service endpoint.",
    );
  }
  const globalArgs = Object.freeze([...target.globalArgs]);
  const env = { ...engine[nativeBinding].env };
  if (engine.id === "docker") {
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_HOST;
  } else {
    delete env.CONTAINER_HOST;
    delete env.CONTAINER_CONNECTION;
  }
  return Object.freeze({
    ...engine,
    globalArgs: engine.id === "podman" && target.key === "local" ? ["--remote=false"] : globalArgs,
    [nativeBinding]: Object.freeze({
      ...engine[nativeBinding],
      env: Object.freeze(env),
      target: Object.freeze({ key: target.key, globalArgs }),
    }),
  });
}

export function readNativeSandboxEngineTarget(engine: SandboxContainerEngine) {
  const target = isBoundEngine(engine) ? engine[nativeBinding].target : undefined;
  return target ? { key: target.key, globalArgs: [...target.globalArgs] } : undefined;
}

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
  return await runContainerRaw(engine, args, opts);
}

async function runContainerRaw(
  engine: SandboxContainerEngine,
  args: string[],
  opts?: ExecContainerRawOptions,
  cleanup = false,
): Promise<ExecDockerRawResult> {
  const binding = isBoundEngine(engine) ? engine[nativeBinding] : undefined;
  if (binding && !cleanup) {
    throw new Error("Cleanup-only sandbox transport cannot execute work.");
  }
  let result;
  try {
    result = await spawnCommand(
      [binding?.executable ?? engine.command, ...(engine.globalArgs ?? []), ...args],
      {
        ...(binding ? { baseEnv: binding.env, cwd: binding.cwd } : {}),
        cancelSignal: opts?.signal,
        encoding: "buffer",
        input: opts?.input ?? Buffer.alloc(0),
        maxBuffer: SANDBOX_COMMAND_MAX_BUFFER_BYTES,
        reject: false,
        stripFinalNewline: false,
      },
    );
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

/** Cleanup never re-enters the revoked producer set it is joining. */
export async function runNativeSandboxCleanup<T>(
  engine: SandboxContainerEngine,
  run: (
    exec: (args: string[], allowFailure?: boolean) => Promise<ExecDockerRawResult>,
  ) => Promise<T>,
): Promise<T> {
  if (!isBoundEngine(engine) || !engine[nativeBinding].target) {
    throw new Error("Native sandbox cleanup requires its captured target and custody.");
  }
  const signal = AbortSignal.timeout(NATIVE_SANDBOX_SETTLEMENT_MS);
  return await runOutsideCommandProcessScope(() =>
    withCommandProcessScope(
      () =>
        run((args, allowFailure) => runContainerRaw(engine, args, { signal, allowFailure }, true)),
      signal,
    ),
  );
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
