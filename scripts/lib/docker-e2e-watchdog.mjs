// Shared Node fallback for host Docker and in-container E2E command timeouts.
import { pathToFileURL } from "node:url";

export function parseTimeoutMs(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/u.exec(String(value ?? "").trim());
  if (!match) {
    throw new Error(`unsupported timeout value: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.max(1, Math.ceil(amount * multiplier));
}

export async function runWatchdog(kind, timeoutValue, [command, ...args]) {
  const docker = kind === "docker";
  const label = docker ? "Docker" : "OpenClaw E2E";

  if (!command) {
    console.error("missing command for Node watchdog");
    process.exit(1);
  }

  const { spawn } = await import("node:child_process");
  let timeoutMs;
  try {
    timeoutMs = parseTimeoutMs(timeoutValue);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  let timedOut = false;
  let parentSignal = null;
  let parentSignalTimer = null;
  const signalExitCodes = new Map([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]);
  const killGraceMs = Number.parseInt(
    process.env[
      docker ? "OPENCLAW_DOCKER_TIMEOUT_KILL_GRACE_MS" : "OPENCLAW_E2E_TIMEOUT_KILL_GRACE_MS"
    ] || "30000",
    10,
  );
  const killChild = (signal) => {
    if (!child.pid) {
      return;
    }
    const killTarget = process.platform === "win32" ? child.pid : -child.pid;
    try {
      process.kill(killTarget, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`${label} command timed out after ${timeoutValue}`);
    killChild("SIGTERM");
    setTimeout(() => killChild("SIGKILL"), killGraceMs).unref();
  }, timeoutMs);
  const forwardSignal = (signal) => {
    if (parentSignal) {
      killChild("SIGKILL");
      process.exit(signalExitCodes.get(signal) ?? 1);
    }
    parentSignal = signal;
    clearTimeout(timer);
    killChild(signal);
    parentSignalTimer = setTimeout(() => {
      killChild("SIGKILL");
      process.exit(signalExitCodes.get(signal) ?? 1);
    }, killGraceMs);
    parentSignalTimer.unref();
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  process.once("SIGHUP", forwardSignal);
  // In-container commands settle their inherited streams; host Docker wrappers settle on exit.
  child.on(docker ? "exit" : "close", (code, signal) => {
    clearTimeout(timer);
    if (parentSignalTimer) {
      clearTimeout(parentSignalTimer);
    }
    if (timedOut) {
      process.exit(124);
    }
    if (parentSignal) {
      process.exit(signalExitCodes.get(parentSignal) ?? 1);
    }
    if (code !== null) {
      process.exit(code);
    }
    if (signal) {
      process.kill(process.pid, signal);
    }
    process.exit(1);
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exit(127);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, timeoutValue, ...args] = process.argv.slice(2);
  await runWatchdog(kind, timeoutValue, args);
}
