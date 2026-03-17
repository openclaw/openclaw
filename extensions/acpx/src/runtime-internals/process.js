import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  applyWindowsSpawnProgramPolicy,
  listKnownProviderAuthEnvVarNames,
  materializeWindowsSpawnProgram,
  omitEnvKeysCaseInsensitive,
  resolveWindowsSpawnProgramCandidate
} from "openclaw/plugin-sdk/acpx";
const DEFAULT_RUNTIME = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath
};
function resolveSpawnCommand(params, options, runtime = DEFAULT_RUNTIME) {
  const strictWindowsCmdWrapper = options?.strictWindowsCmdWrapper === true;
  const cacheKey = params.command;
  const cachedProgram = options?.cache;
  const cacheHit = cachedProgram?.key === cacheKey && cachedProgram.candidate != null;
  let candidate = cachedProgram?.key === cacheKey && cachedProgram.candidate ? cachedProgram.candidate : void 0;
  if (!candidate) {
    candidate = resolveWindowsSpawnProgramCandidate({
      command: params.command,
      platform: runtime.platform,
      env: runtime.env,
      execPath: runtime.execPath,
      packageName: "acpx"
    });
    if (cachedProgram) {
      cachedProgram.key = cacheKey;
      cachedProgram.candidate = candidate;
    }
  }
  let program;
  try {
    program = applyWindowsSpawnProgramPolicy({
      candidate,
      allowShellFallback: !strictWindowsCmdWrapper
    });
  } catch (error) {
    options?.onResolved?.({
      command: params.command,
      cacheHit,
      strictWindowsCmdWrapper,
      resolution: candidate.resolution
    });
    throw error;
  }
  const resolved = materializeWindowsSpawnProgram(program, params.args);
  options?.onResolved?.({
    command: params.command,
    cacheHit,
    strictWindowsCmdWrapper,
    resolution: resolved.resolution
  });
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide
  };
}
function createAbortError() {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}
function spawnWithResolvedCommand(params, options) {
  const resolved = resolveSpawnCommand(
    {
      command: params.command,
      args: params.args
    },
    options
  );
  const childEnv = omitEnvKeysCaseInsensitive(
    process.env,
    params.stripProviderAuthEnvVars ? listKnownProviderAuthEnvVarNames() : []
  );
  childEnv.OPENCLAW_SHELL = "acp";
  return spawn(resolved.command, resolved.args, {
    cwd: params.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
    windowsHide: resolved.windowsHide
  });
}
async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
      error: null
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.once("error", (err) => {
      finish({ code: null, signal: null, error: err });
    });
    child.once("close", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}
async function spawnAndCollect(params, options, runtime) {
  if (runtime?.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      code: null,
      error: createAbortError()
    };
  }
  const child = spawnWithResolvedCommand(params, options);
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let abortKillTimer;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      child.kill("SIGTERM");
    } catch {
    }
    abortKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, 250);
    abortKillTimer.unref?.();
  };
  runtime?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const exit = await waitForExit(child);
    return {
      stdout,
      stderr,
      code: exit.code,
      error: aborted ? createAbortError() : exit.error
    };
  } finally {
    runtime?.signal?.removeEventListener("abort", onAbort);
    if (abortKillTimer) {
      clearTimeout(abortKillTimer);
    }
  }
}
function resolveSpawnFailure(err, cwd) {
  if (!err || typeof err !== "object") {
    return null;
  }
  const code = err.code;
  if (code !== "ENOENT") {
    return null;
  }
  return directoryExists(cwd) ? "missing-command" : "missing-cwd";
}
function directoryExists(cwd) {
  if (!cwd) {
    return false;
  }
  try {
    return existsSync(cwd);
  } catch {
    return false;
  }
}
export {
  resolveSpawnCommand,
  resolveSpawnFailure,
  spawnAndCollect,
  spawnWithResolvedCommand,
  waitForExit
};
