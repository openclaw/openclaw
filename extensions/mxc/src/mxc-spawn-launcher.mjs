#!/usr/bin/env node

import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function decodePayload(argv) {
  const payloadFileIndex = argv.indexOf("--payload-file");
  if (payloadFileIndex < 0) {
    throw new Error("Missing --payload-file");
  }
  const payloadFile = argv[payloadFileIndex + 1];
  if (!payloadFile) {
    throw new Error("Missing --payload-file value");
  }
  const payloadJson = readFileSync(payloadFile, "utf8");
  rmSync(path.dirname(payloadFile), { force: true, recursive: true });
  return JSON.parse(payloadJson);
}

const FORWARDED_SIGNAL_EXIT_GRACE_MS = 1000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

function formatErrorStack(error) {
  if (error && typeof error === "object" && typeof error.stack === "string") {
    return error.stack;
  }
  return String(error);
}

// The exec supervisor or runCommandBuffered owns descendant-tree cancellation.
// This SDK bridge must stay alive for close; exiting the launcher is not that join.
export function forwardSignals(spawned, options = {}) {
  let exitTimer;
  let forcedExitCode;
  const listeners = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => {
      try {
        spawned.kill(signal);
      } catch {
        // The sandbox may already be closing.
      }
      if (exitTimer) {
        return;
      }
      exitTimer = (options.setTimeout ?? setTimeout)(() => {
        forcedExitCode = signalExitCode(signal);
        // Reap the owned sandbox, not this launcher or its pending output.
        try {
          spawned.kill("SIGKILL");
        } catch {
          // Completion still belongs to the sandbox's close notification.
        }
      }, options.exitGraceMs ?? FORWARDED_SIGNAL_EXIT_GRACE_MS);
      exitTimer?.unref?.();
    };
    process.on(signal, listener);
    listeners.set(signal, listener);
  }
  return {
    exitCode: () => forcedExitCode,
    dispose() {
      if (exitTimer) {
        (options.clearTimeout ?? clearTimeout)(exitTimer);
      }
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
    },
  };
}

function bridgeStdio(pty) {
  const output = pty.onData((data) => process.stdout.write(data));
  const onData = (data) => pty.write(data);
  const onEnd = () => pty.write("\x04");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  return () => {
    output.dispose();
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.pause();
  };
}

function bridgeChildProcess(child) {
  // pipe owns backpressure; leave process output open for natural final draining.
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  if (child.stdin) {
    process.stdin.pipe(child.stdin);
  }
  return () => {
    child.stdout?.unpipe(process.stdout);
    child.stderr?.unpipe(process.stderr);
    if (child.stdin) {
      process.stdin.unpipe(child.stdin);
      child.stdin.destroy();
    }
    process.stdin.pause();
  };
}

async function attachPtyProcess(spawned) {
  const disposeStdio = bridgeStdio(spawned);
  const signals = forwardSignals(spawned);
  let exitSubscription;
  try {
    // node-pty emits onExit after its terminal output socket closes.
    const { exitCode, signal } = await new Promise((resolve) => {
      exitSubscription = spawned.onExit(resolve);
    });
    process.exitCode =
      signals.exitCode() ?? (typeof exitCode === "number" ? exitCode : signalExitCode(signal));
  } finally {
    exitSubscription?.dispose();
    signals.dispose();
    disposeStdio();
  }
}

async function attachChildProcess(spawned) {
  const disposeStdio = bridgeChildProcess(spawned);
  const signals = forwardSignals(spawned);
  /** @type {Error | undefined} */
  let failure;
  const onError = (error) => {
    failure = error;
  };
  spawned.on("error", onError);
  // EPIPE is normal when a sandbox finishes before the invoking input producer.
  const onInputError = (error) => {
    if (error.code !== "EPIPE") {
      failure = error;
      spawned.kill("SIGTERM");
    }
  };
  spawned.stdin?.on("error", onInputError);
  try {
    const { exitCode, signal } = await new Promise((resolve) => {
      spawned.once("close", (code, exitSignal) => resolve({ exitCode: code, signal: exitSignal }));
    });
    if (failure) {
      throw failure;
    }
    process.exitCode =
      signals.exitCode() ?? (typeof exitCode === "number" ? exitCode : signalExitCode(signal));
  } finally {
    signals.dispose();
    disposeStdio();
    spawned.off("error", onError);
    spawned.stdin?.off("error", onInputError);
  }
}

export async function launchSandbox(spawnSandboxFromConfig, config, options, bridges = {}) {
  const spawned = await spawnSandboxFromConfig(config, options ?? {});
  if (typeof spawned.onData === "function") {
    await (bridges.pty ?? attachPtyProcess)(spawned);
  } else {
    await (bridges.child ?? attachChildProcess)(spawned);
  }
}

const SIGNAL_NUMBERS = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGQUIT", 3],
  ["SIGTERM", 15],
]);

export function signalExitCode(signal) {
  if (typeof signal === "number" && Number.isFinite(signal)) {
    return 128 + signal;
  }
  if (typeof signal === "string") {
    const signalNumber = SIGNAL_NUMBERS.get(signal);
    if (signalNumber !== undefined) {
      return 128 + signalNumber;
    }
  }
  return 1;
}

function isMain() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

export async function main() {
  try {
    const { config, options } = decodePayload(process.argv.slice(2));
    const { spawnSandboxFromConfig } = await import("@microsoft/mxc-sdk");
    await launchSandbox(spawnSandboxFromConfig, config, options);
  } catch (error) {
    process.stderr.write(`${formatErrorStack(error)}\n`);
    process.exitCode = 127;
  }
}

if (isMain()) {
  void main();
}
