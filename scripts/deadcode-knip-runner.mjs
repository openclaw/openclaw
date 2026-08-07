import { spawn } from "node:child_process";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mjs";
import { terminateManagedChild } from "./lib/managed-child-process.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";

const KNIP_VERSION = "6.8.0";
const KNIP_TIMEOUT_MS = 10 * 60 * 1000;
const KNIP_KILL_GRACE_MS = 5_000;
const KNIP_PROCESS_TREE_EXIT_POLL_MS = 25;
const KNIP_POST_FORCE_KILL_WAIT_MS = 1_000;
const KNIP_CLOSE_HANDSHAKE_MS = 1_000;
const KNIP_HEARTBEAT_MS = 60_000;
const PNPM_DLX_LAYOUT_ENV_KEYS = new Set([
  "pnpm_config_modules_dir",
  "pnpm_config_virtual_store_dir",
  "npm_config_modules_dir",
  "npm_config_virtual_store_dir",
]);

/** Maximum buffered Knip output retained for diagnostics. */
export const KNIP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRepoPath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function isLikelyRepoFilePath(value) {
  const normalized = normalizeRepoPath(value);
  return (
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    /\.(?:[cm]?[jt]sx?)$/u.test(normalized)
  );
}

function spawnErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function createKnipChildEnv(env) {
  const childEnv = { ...(env ?? process.env) };
  for (const key of Object.keys(childEnv)) {
    if (PNPM_DLX_LAYOUT_ENV_KEYS.has(key.toLowerCase())) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function processTreeAlive(child, platform) {
  if (platform === "win32" || !child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessTreeExit(child, platform, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!processTreeAlive(child, platform)) {
      return true;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, KNIP_PROCESS_TREE_EXIT_POLL_MS);
    });
  }
  return !processTreeAlive(child, platform);
}

function withProcessTreeCleanupFailure(result, platform) {
  const platformName = platform === "win32" ? "Windows " : "";
  return {
    ...result,
    errorCode: "EPROCESSGROUP_CLEANUP_FAILED",
    errorMessage: `${result.errorMessage}; ${platformName}process tree cleanup could not be verified`,
  };
}

/** Runs pinned Knip with the supplied CLI arguments. */
export async function runKnip(knipArgs, params = {}) {
  const run = params.spawnCommand ?? spawn;
  const timeoutMs = params.timeoutMs ?? KNIP_TIMEOUT_MS;
  const heartbeatMs = params.heartbeatMs ?? KNIP_HEARTBEAT_MS;
  const maxBufferBytes = params.maxBufferBytes ?? KNIP_MAX_BUFFER_BYTES;
  const killGraceMs = params.killGraceMs ?? KNIP_KILL_GRACE_MS;
  const closeHandshakeMs = params.closeHandshakeMs ?? KNIP_CLOSE_HANDSHAKE_MS;
  const scanName = params.scanName ?? "scan";
  const writeStatus = params.writeStatus ?? ((message) => process.stderr.write(`${message}\n`));
  const platform = params.platform ?? process.platform;
  const runTaskkill = params.runTaskkill;
  const args = [
    "--config.minimum-release-age=0",
    "dlx",
    "--package",
    `knip@${KNIP_VERSION}`,
    "knip",
    ...knipArgs,
  ];

  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let terminalFailure;
    let outputBytes = 0;
    const output = [];
    let closeTimer;
    let killTimer;
    let timeoutTimer;
    let exitStatus = null;
    let exitSignal = null;
    let detachChildForFallback = () => {};
    let cleanupChildListeners = () => {};

    const pnpm = createPnpmRunnerSpawnSpec({
      detached: platform !== "win32",
      env: createKnipChildEnv(params.env),
      nodeExecPath: params.nodeExecPath,
      npmExecPath: params.npmExecPath,
      platform,
      pnpmArgs: args,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = run(pnpm.command, pnpm.args, {
      ...pnpm.options,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parentSignalHandlers = [];
    const cleanupParentSignalHandlers = () => {
      for (const { signal, handler } of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.length = 0;
    };
    const relayParentSignal = (signal) => {
      const handler = () => {
        terminateManagedChild(child, signal, { platform, runTaskkill });
        if (platform !== "win32") {
          terminateManagedChild(child, "SIGKILL", { platform });
        }
        cleanupParentSignalHandlers();
        process.kill(process.pid, signal);
      };
      parentSignalHandlers.push({ signal, handler });
      process.once(signal, handler);
    };
    if (process.platform !== "win32") {
      relayParentSignal("SIGINT");
      relayParentSignal("SIGTERM");
      relayParentSignal("SIGHUP");
    }

    const heartbeatTimer = setInterval(() => {
      writeStatus(
        `[deadcode] Knip ${scanName} still running after ${Math.round((Date.now() - startedAt) / 1000)}s.`,
      );
    }, heartbeatMs);
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      clearInterval(heartbeatTimer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      cleanupChildListeners();
      cleanupParentSignalHandlers();
      resolve({ ...result, output: output.join("") });
    };
    const finishAfterProcessTreeCleanup = async (result, forceImmediately = false) => {
      if (settled) {
        return;
      }
      if (!forceImmediately && processTreeAlive(child, platform)) {
        await waitForProcessTreeExit(child, platform, killGraceMs);
      }
      if (processTreeAlive(child, platform)) {
        terminateManagedChild(child, "SIGKILL", { platform });
        await waitForProcessTreeExit(child, platform, KNIP_POST_FORCE_KILL_WAIT_MS);
      }
      if (processTreeAlive(child, platform)) {
        finish(withProcessTreeCleanupFailure(result, platform));
        return;
      }
      finish(result);
    };
    const terminateChild = (signal, failureResult) => {
      const termination = terminateManagedChild(child, signal, {
        platform,
        runTaskkill,
      });
      if (termination?.processTreeState !== "indeterminate") {
        return true;
      }
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
      finish(withProcessTreeCleanupFailure(failureResult, platform));
      return false;
    };
    const scheduleForceKill = (failureResult) => {
      if (platform === "win32" || settled || killTimer) {
        return;
      }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (settled || terminalFailure !== failureResult) {
          return;
        }
        terminateChild("SIGKILL", failureResult);
      }, killGraceMs);
    };
    const scheduleCloseFallback = (failureResult) => {
      if (settled || closeTimer) {
        return;
      }
      // Tree termination and ChildProcess close are separate handshakes. Bound
      // the latter so a missing close cannot suppress the wrapper failure.
      const waitMs = platform === "win32" ? closeHandshakeMs : killGraceMs + closeHandshakeMs;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (settled || terminalFailure !== failureResult) {
          return;
        }
        detachChildForFallback();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
        void finishAfterProcessTreeCleanup(
          {
            ...failureResult,
            signal: exitSignal,
            status: exitStatus,
          },
          true,
        );
      }, waitMs);
    };
    // Timeout and output capping compete; the first cause owns cleanup and the result.
    const claimTerminalFailure = (failureResult) => {
      if (settled || terminalFailure) {
        return false;
      }
      terminalFailure = failureResult;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      clearInterval(heartbeatTimer);
      return true;
    };
    const terminateForFailure = (failureResult) => {
      // Windows taskkill must force the tree; /T alone can return before Node
      // observes process close, while POSIX keeps its graceful escalation.
      const signal = platform === "win32" ? "SIGKILL" : "SIGTERM";
      if (terminateChild(signal, failureResult)) {
        scheduleForceKill(failureResult);
        scheduleCloseFallback(failureResult);
      }
    };

    const appendOutput = (chunk) => {
      if (settled || terminalFailure) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remainingBytes = maxBufferBytes - outputBytes;
      if (buffer.length <= remainingBytes) {
        output.push(buffer.toString("utf8"));
        outputBytes += buffer.length;
        return;
      }
      if (remainingBytes > 0) {
        output.push(buffer.subarray(0, remainingBytes).toString("utf8"));
        outputBytes = maxBufferBytes;
      }
      const failureResult = {
        errorCode: "ENOBUFS",
        errorMessage: `Knip ${scanName} exceeded ${maxBufferBytes} output bytes`,
        signal: exitSignal,
        status: exitStatus,
      };
      if (!claimTerminalFailure(failureResult)) {
        return;
      }
      writeStatus(
        `[deadcode] Knip ${scanName} exceeded ${maxBufferBytes} output bytes; terminating.`,
      );
      child.stdout?.off?.("data", appendOutput);
      child.stderr?.off?.("data", appendOutput);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      terminateForFailure(failureResult);
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined;
      const failureResult = {
        errorCode: "ETIMEDOUT",
        errorMessage: `Knip ${scanName} timed out after ${Math.round(
          (Date.now() - startedAt) / 1000,
        )}s`,
        signal: exitSignal,
        status: exitStatus,
      };
      if (!claimTerminalFailure(failureResult)) {
        return;
      }
      writeStatus(
        `[deadcode] Knip ${scanName} timed out after ${Math.round(timeoutMs / 1000)}s; terminating.`,
      );
      terminateForFailure(failureResult);
    }, timeoutMs);
    const onChildError = (error) => {
      if (terminalFailure) {
        return;
      }
      finish({
        errorCode: spawnErrorCode(error),
        errorMessage: error.message,
        signal: null,
        status: null,
      });
    };
    const onChildExit = (status, signal) => {
      exitStatus = status;
      exitSignal = signal;
    };
    const onChildClose = (status, signal) => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      exitStatus = exitStatus ?? status;
      exitSignal = exitSignal ?? signal;
      if (terminalFailure) {
        void finishAfterProcessTreeCleanup({
          ...terminalFailure,
          signal: exitSignal,
          status: exitStatus,
        });
        return;
      }
      finish({
        errorCode: undefined,
        errorMessage: undefined,
        signal: exitSignal,
        status: exitStatus,
      });
    };
    detachChildForFallback = () => {
      child.stdout?.off?.("data", appendOutput);
      child.stderr?.off?.("data", appendOutput);
      child.off?.("close", onChildClose);
    };
    cleanupChildListeners = () => {
      detachChildForFallback();
      child.off?.("error", onChildError);
      child.off?.("exit", onChildExit);
    };
    child.on("error", onChildError);
    child.on("exit", onChildExit);
    child.on("close", onChildClose);
  });
}

async function main() {
  const result = await runKnip(process.argv.slice(2), { scanName: "command" });
  if (result.output) {
    process.stdout.write(result.output);
  }
  const exitCode = result.errorCode === undefined ? (result.status ?? 1) : 1;
  if (result.errorMessage) {
    process.stderr.write(`[deadcode] ${result.errorMessage}\n`);
  }
  process.exitCode = exitCode;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runWithFailedTrailer("deadcode", main);
}
