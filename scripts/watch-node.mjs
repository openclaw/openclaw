#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { isRestartRelevantRunNodePath, runNodeWatchedPaths } from "./run-node.mjs";

const WATCH_NODE_RUNNER = "scripts/run-node.mjs";
const WATCH_RESTART_SIGNAL = "SIGTERM";
const WATCH_RESTARTABLE_CHILD_EXIT_CODES = new Set([143]);
const WATCH_RESTARTABLE_CHILD_SIGNALS = new Set(["SIGTERM"]);

const buildRunnerArgs = (args) => [WATCH_NODE_RUNNER, ...args];

const normalizePath = (filePath) =>
  String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");

const resolveRepoPath = (filePath, cwd) => {
  const rawPath = String(filePath ?? "");
  if (path.isAbsolute(rawPath)) {
    return normalizePath(path.relative(cwd, rawPath));
  }
  return normalizePath(rawPath);
};

const isDirectoryLikeWatchedPath = (repoPath, watchPaths) => {
  const normalizedRepoPath = normalizePath(repoPath).replace(/\/$/, "");
  return watchPaths.some((watchPath) => {
    const normalizedWatchPath = normalizePath(watchPath).replace(/\/$/, "");
    if (!normalizedWatchPath) {
      return false;
    }
    return (
      normalizedRepoPath === normalizedWatchPath ||
      normalizedRepoPath.startsWith(`${normalizedWatchPath}/`)
    );
  });
};

const isIgnoredWatchPath = (filePath, cwd, watchPaths) => {
  const repoPath = resolveRepoPath(filePath, cwd);
  const statPath = path.isAbsolute(String(filePath ?? ""))
    ? String(filePath ?? "")
    : path.join(cwd, String(filePath ?? ""));
  try {
    if (fs.statSync(statPath).isDirectory() && isDirectoryLikeWatchedPath(repoPath, watchPaths)) {
      return false;
    }
  } catch {
    // Fall through to path-based filtering for deleted paths and other transient races.
  }
  return !isRestartRelevantRunNodePath(repoPath);
};

const shouldRestartAfterChildExit = (exitCode, exitSignal) =>
  (typeof exitCode === "number" && WATCH_RESTARTABLE_CHILD_EXIT_CODES.has(exitCode)) ||
  (typeof exitSignal === "string" && WATCH_RESTARTABLE_CHILD_SIGNALS.has(exitSignal));

/**
 * @param {{
 *   spawn?: typeof spawn;
 *   process?: NodeJS.Process;
 *   cwd?: string;
 *   args?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   now?: () => number;
 *   createWatcher?: (
 *     watchPaths: string[],
 *     options: { ignoreInitial: boolean; ignored: (watchPath: string) => boolean },
 *   ) => { on: (event: string, cb: (...args: unknown[]) => void) => void; close?: () => Promise<void> };
 *   watchPaths?: string[];
 * }} [params]
 */
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
  // The watcher owns process restarts; keep SIGUSR1/config reloads in-process
  // so inherited launchd/systemd markers do not make the child exit and stall.
  childEnv.OPENCLAW_NO_RESPAWN = "1";
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
      ignored: (watchPath) => isIgnoredWatchPath(watchPath, deps.cwd, deps.watchPaths),
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
      watchProcess.on("exit", (exitCode, exitSignal) => {
        watchProcess = null;
        if (shuttingDown) {
          return;
        }
        if (restartRequested || shouldRestartAfterChildExit(exitCode, exitSignal)) {
          restartRequested = false;
          startRunner();
          return;
        }
        settle(exitSignal ? 1 : (exitCode ?? 1));
      });
    };

    const requestRestart = (changedPath) => {
      if (shuttingDown || isIgnoredWatchPath(changedPath, deps.cwd, deps.watchPaths)) {
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
