#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { runNodeWatchedPaths } from "./run-node.mjs";

const WATCH_NODE_RUNNER = "scripts/run-node.mjs";
const WATCH_RESTART_SIGNAL = "SIGTERM";

const buildRunnerArgs = (args) => [WATCH_NODE_RUNNER, ...args];

const normalizePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

const isIgnoredWatchPath = (filePath) => {
  const normalizedPath = normalizePath(filePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

export async function runWatchMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    process: params.process ?? process,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    now: params.now ?? Date.now,
    createWatcher:
      params.createWatcher ?? ((watchPaths, options) => chokidar.watch(watchPaths, options)),
    watchPaths: params.watchPaths ?? runNodeWatchedPaths,
  };

  const childEnv = { ...deps.env };
  const watchSession = `${deps.now()}-${deps.process.pid}`;
  childEnv.OPENCLAW_WATCH_MODE = "1";
  childEnv.OPENCLAW_WATCH_SESSION = watchSession;
  if (deps.args.length > 0) {
    childEnv.OPENCLAW_WATCH_COMMAND = deps.args.join(" ");
  }

  return await new Promise((resolve) => {
    let settled = false;
    let shuttingDown = false;
    let restartRequested = false;
    let watchProcess = null;
    let onSigInt;
    let onSigTerm;

    const watcher = deps.createWatcher(deps.watchPaths, {
      ignoreInitial: true,
      ignored: (watchPath) => isIgnoredWatchPath(watchPath),
    });

    const settle = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (onSigInt) {
        deps.process.off("SIGINT", onSigInt);
      }
      if (onSigTerm) {
        deps.process.off("SIGTERM", onSigTerm);
      }
      watcher.close?.().catch?.(() => {});
      resolve(code);
    };

    const startRunner = () => {
      watchProcess = deps.spawn(deps.process.execPath, buildRunnerArgs(deps.args), {
        cwd: deps.cwd,
        env: childEnv,
        stdio: "inherit",
      });
      watchProcess.on("exit", () => {
        watchProcess = null;
        if (shuttingDown) {
          return;
        }
        if (restartRequested) {
          restartRequested = false;
          startRunner();
        }
      });
    };

    const requestRestart = (changedPath) => {
      if (shuttingDown || isIgnoredWatchPath(changedPath)) {
        return;
      }
      if (!watchProcess) {
        startRunner();
        return;
      }
      restartRequested = true;
      if (typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
    };

    watcher.on("add", requestRestart);
    watcher.on("change", requestRestart);
    watcher.on("unlink", requestRestart);
    watcher.on("error", () => {
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
      settle(1);
    });

    startRunner();

    onSigInt = () => {
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
      settle(130);
    };
    onSigTerm = () => {
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
      settle(143);
    };

    deps.process.on("SIGINT", onSigInt);
    deps.process.on("SIGTERM", onSigTerm);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runWatchMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
