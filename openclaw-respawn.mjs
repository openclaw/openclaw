import { spawn as defaultSpawn } from "node:child_process";

export const respawnSignals =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
export const respawnSignalExitGraceMs = 1_000;
export const respawnSignalForceKillGraceMs = 1_000;

const killChild = (child, signal) => {
  try {
    child.kill(signal);
  } catch {
    // Best-effort signal forwarding.
  }
};

export function runRespawnedChild({
  command,
  args,
  env,
  spawn = defaultSpawn,
  exit = process.exit,
  writeError = (message) => process.stderr.write(message),
  errorMessage = "[openclaw] Failed to respawn launcher",
  platform = process.platform,
  signals = respawnSignals,
  signalExitGraceMs = respawnSignalExitGraceMs,
  signalForceKillGraceMs = respawnSignalForceKillGraceMs,
}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  const listeners = new Map();
  let gracefulExitTimer = null;
  let forceExitTimer = null;
  const clearSignalExitTimers = () => {
    if (gracefulExitTimer) {
      clearTimeout(gracefulExitTimer);
      gracefulExitTimer = null;
    }
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
  };
  const detach = () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
    clearSignalExitTimers();
  };
  const scheduleParentExit = () => {
    if (gracefulExitTimer || forceExitTimer) {
      return;
    }
    // Forward the user's signal first, then escalate so children that ignore
    // SIGTERM cannot keep the launcher wrapper alive indefinitely.
    gracefulExitTimer = setTimeout(() => {
      killChild(child, "SIGTERM");
      forceExitTimer = setTimeout(() => {
        killChild(child, platform === "win32" ? "SIGTERM" : "SIGKILL");
        exit(1);
      }, signalForceKillGraceMs);
      forceExitTimer.unref?.();
    }, signalExitGraceMs);
    gracefulExitTimer.unref?.();
  };
  for (const signal of signals) {
    const listener = () => {
      killChild(child, signal);
      scheduleParentExit();
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }
  child.once("exit", (code, signal) => {
    detach();
    if (signal) {
      exit(1);
    }
    exit(code ?? 1);
  });
  child.once("error", (error) => {
    detach();
    writeError(
      `${errorMessage}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    exit(1);
  });
  return child;
}
