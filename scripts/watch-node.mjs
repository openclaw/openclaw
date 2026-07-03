#!/usr/bin/env node
// Watches dev source paths and restarts scripts/run-node.mjs when relevant
// files change.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRestartRelevantRunNodePath, runNodeWatchedPaths } from "./run-node-watch-paths.mjs";
import { resolveGitHead, BUILD_STAMP_FILE } from "./lib/local-build-metadata.mjs";

const WATCH_NODE_RUNNER = "scripts/run-node.mjs";
const WATCH_RESTART_SIGNAL = "SIGTERM";
const WATCH_RESTARTABLE_CHILD_EXIT_CODES = new Set([143]);
const WATCH_RESTARTABLE_CHILD_SIGNALS = new Set(["SIGTERM"]);
const WATCH_IGNORED_PATH_SEGMENTS = new Set([".git", "dist", "node_modules"]);
const WATCH_LOCK_WAIT_MS = 5_000;
const WATCH_LOCK_POLL_MS = 100;
const WATCH_SHUTDOWN_KILL_GRACE_MS = 5_000;
const WATCH_LOCK_DIR = path.join(".local", "watch-node");
const AUTO_DOCTOR_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);

const buildRunnerArgs = (args) => [WATCH_NODE_RUNNER, ...args];
const buildDoctorRunnerArgs = () => [WATCH_NODE_RUNNER, "doctor", "--fix", "--non-interactive"];

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

const hasIgnoredPathSegment = (repoPath) =>
  normalizePath(repoPath)
    .split("/")
    .some((segment) => WATCH_IGNORED_PATH_SEGMENTS.has(segment));

const looksLikeDirectoryPath = (repoPath) => path.posix.extname(normalizePath(repoPath)) === "";

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

const isIgnoredWatchPath = (filePath, cwd, watchPaths, stats) => {
  const repoPath = resolveRepoPath(filePath, cwd);
  if (hasIgnoredPathSegment(repoPath)) {
    return true;
  }
  if (isDirectoryLikeWatchedPath(repoPath, watchPaths)) {
    if (stats?.isDirectory?.() || looksLikeDirectoryPath(repoPath)) {
      return false;
    }
  }
  return !isRestartRelevantRunNodePath(repoPath);
};

const shouldRestartAfterChildExit = (exitCode, exitSignal) =>
  (typeof exitCode === "number" && WATCH_RESTARTABLE_CHILD_EXIT_CODES.has(exitCode)) ||
  (typeof exitSignal === "string" && WATCH_RESTARTABLE_CHILD_SIGNALS.has(exitSignal));

/** Common config files whose mtime changes indicate a rebuild may be needed. */
const WATCH_REBUILD_CONFIG_FILES = [
  "tsdown.config.ts",
  "tsconfig.json",
  "package.json",
];

/**
 * Checks whether the current build output is ready for a hot-reload restart.
 * Mirrors the rebuild-trigger conditions from run-node's resolveBuildRequirement():
 *   1. dist/entry.js exists
 *   2. Build stamp exists and is readable
 *   3. Build stamp git HEAD matches current checkout HEAD
 *   4. Config files (tsdown.config.ts, tsconfig.json) are not newer than stamp
 *   5. Source roots are not newer than stamp (proxy for source mtime drift)
 *   6. Runtime postbuild stamp exists (postbuild outputs are complete)
 *
 * When git is unavailable or stamp is unreadable, falls back to a
 * conservative subset of checks (entry.js + stamp + config mtime).
 *
 * @param {string} cwd
 * @param {{ existsSync: (p: string) => boolean; readFileSync?: (p: string, e?: string) => string; statSync?: (p: string) => { mtime: Date } }} fsModule
 * @param {(opts: { cwd: string }) => string | null} [resolveHead]
 * @returns {boolean}
 */
export const isBuildReadyForRestart = (cwd, fsModule, resolveHead) => {
  const entryPath = path.join(cwd, "dist", "entry.js");
  if (!fsModule.existsSync(entryPath)) {
    return false;
  }

  // Without readFileSync (test mock), just check entry.js existence
  if (typeof fsModule.readFileSync !== "function") {
    return true;
  }

  let stamp;
  let stampPath;
  try {
    stampPath = path.join(cwd, "dist", BUILD_STAMP_FILE);
    if (!fsModule.existsSync(stampPath)) {
      return false;
    }
    const raw = fsModule.readFileSync(stampPath, "utf8");
    stamp = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!stamp || typeof stamp.builtAt !== "number") {
    return false;
  }

  // Build stamp HEAD must match current git HEAD (when git is available)
  try {
    const currentHead = (resolveHead ?? resolveGitHead)({ cwd });
    if (currentHead && stamp.head && currentHead !== stamp.head) {
      return false;
    }
  } catch {
    // git unavailable — skip HEAD check
  }

  // Config files must not be newer than build stamp
  if (typeof fsModule.statSync === "function" && stamp.builtAt) {
    for (const configFile of WATCH_REBUILD_CONFIG_FILES) {
      try {
        const configPath = path.join(cwd, configFile);
        if (fsModule.existsSync(configPath)) {
          const configStat = fsModule.statSync(configPath);
          if (configStat.mtime.getTime() > stamp.builtAt) {
            return false;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  // Runtime postbuild stamp must exist (postbuild outputs are complete)
  try {
    const postbuildStampPath = path.join(cwd, "dist", ".runtime-postbuildstamp");
    if (fsModule.existsSync(postbuildStampPath)) {
      const raw = fsModule.readFileSync(postbuildStampPath, "utf8");
      const postbuildStamp = JSON.parse(raw);
      if (!postbuildStamp || typeof postbuildStamp.builtAt !== "number") {
        return false;
      }
    } else {
      return false;
    }
  } catch {
    return false;
  }

  return true;
};

const isGatewayWatchCommand = (args) => args[0] === "gateway";

const shouldRunAutoDoctor = (deps, autoDoctorAttempted) =>
  !autoDoctorAttempted &&
  isGatewayWatchCommand(deps.args) &&
  !AUTO_DOCTOR_DISABLE_VALUES.has(
    String(deps.env.OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR ?? "").toLowerCase(),
  );

const isProcessAlive = (pid, signalProcess) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    signalProcess(pid, 0);
  } catch {
    return false;
  }
  return true;
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createWatchLockKey = (cwd, args) =>
  createHash("sha256").update(cwd).update("\0").update(args.join("\0")).digest("hex").slice(0, 12);

/** Resolves the lock path that prevents duplicate watch-node loops. */
export const resolveWatchLockPath = (cwd, args = []) =>
  path.join(cwd, WATCH_LOCK_DIR, `${createWatchLockKey(cwd, args)}.json`);

const readWatchLock = (lockPath) => {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
};

const removeWatchLock = (lockPath) => {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
};

const writeWatchLock = (lockPath, payload) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
};

const logWatcher = (message, deps) => {
  deps.process.stderr?.write?.(`[openclaw] ${message}\n`);
};

const isInvalidPackageConfigError = (err) => err?.code === "ERR_INVALID_PACKAGE_CONFIG";

const extractInvalidPackageConfigPath = (err) => {
  const message = String(err?.message ?? "");
  const match = message.match(/Invalid package config (.+?) while importing /);
  return match?.[1] ?? null;
};

const printFriendlyWatchStartupError = (err) => {
  const packageConfigPath = extractInvalidPackageConfigPath(err);

  console.error("");
  console.error(
    "[openclaw] gateway:watch could not start because a dependency package config looks corrupted.",
  );
  if (packageConfigPath) {
    console.error(`[openclaw] Invalid package config: ${packageConfigPath}`);
  }
  console.error("[openclaw] This usually means a file in node_modules is empty or truncated.");
  console.error("[openclaw] Recommended recovery:");
  console.error("[openclaw]   rm -rf node_modules");
  console.error("[openclaw]   pnpm store prune");
  console.error("[openclaw]   pnpm install");
  console.error("");
  console.error("[openclaw] Original error:");
  console.error(err);
};

const loadChokidar = async () => {
  const mod = await import("chokidar");
  return mod.default ?? mod;
};

const waitForWatcherRelease = async (lockPath, pid, deps) => {
  const deadline = deps.now() + WATCH_LOCK_WAIT_MS;
  while (deps.now() < deadline) {
    if (!isProcessAlive(pid, deps.signalProcess)) {
      return true;
    }
    if (!fs.existsSync(lockPath)) {
      return true;
    }
    await deps.sleep(WATCH_LOCK_POLL_MS);
  }
  return !isProcessAlive(pid, deps.signalProcess);
};

const acquireWatchLock = async (deps, watchSession) => {
  const lockPath = resolveWatchLockPath(deps.cwd, deps.args);
  const payload = {
    pid: deps.process.pid,
    command: deps.args.join(" "),
    createdAt: new Date(deps.now()).toISOString(),
    cwd: deps.cwd,
    watchSession,
  };

  while (true) {
    try {
      writeWatchLock(lockPath, payload);
      return { lockPath, pid: deps.process.pid };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existing = readWatchLock(lockPath);
    const existingPid = existing?.pid;
    if (!isProcessAlive(existingPid, deps.signalProcess)) {
      removeWatchLock(lockPath);
      continue;
    }

    logWatcher(`Replacing existing watcher pid ${existingPid}.`, deps);
    try {
      deps.signalProcess(existingPid, WATCH_RESTART_SIGNAL);
    } catch (error) {
      if (isProcessAlive(existingPid, deps.signalProcess)) {
        logWatcher(
          `Failed to stop existing watcher pid ${existingPid}: ${error?.message ?? "unknown error"}`,
          deps,
        );
        return null;
      }
    }

    const released = await waitForWatcherRelease(lockPath, existingPid, deps);
    if (!released) {
      logWatcher(`Timed out waiting for watcher pid ${existingPid} to exit.`, deps);
      return null;
    }
    removeWatchLock(lockPath);
  }
};

const releaseWatchLock = (lockHandle) => {
  if (!lockHandle) {
    return;
  }
  const current = readWatchLock(lockHandle.lockPath);
  if (current?.pid === lockHandle.pid) {
    removeWatchLock(lockHandle.lockPath);
  }
};

/**
 * @param {{
 *   spawn?: typeof spawn;
 *   process?: NodeJS.Process;
 *   cwd?: string;
 *   args?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   now?: () => number;
 *   sleep?: (ms: number) => Promise<void>;
 *   signalProcess?: (pid: number, signal: string | number) => void;
 *   lockDisabled?: boolean;
 *   createWatcher?: (
 *     watchPaths: string[],
 *     options: { ignoreInitial: boolean; ignored: (watchPath: string) => boolean },
 *   ) => { on: (event: string, cb: (...args: unknown[]) => void) => void; close?: () => Promise<void> };
 *   watchPaths?: string[];
 *   fs?: { existsSync: (path: string) => boolean; readFileSync?: (path: string, encoding: string) => string };
 * }} [params]
 */
/**
 * Runs the watch loop and restarts the child process on relevant changes.
 */
export async function runWatchMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    process: params.process ?? process,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    now: params.now ?? Date.now,
    sleep: params.sleep ?? sleep,
    signalProcess: params.signalProcess ?? ((pid, signal) => process.kill(pid, signal)),
    lockDisabled: params.lockDisabled === true,
    createWatcher: params.createWatcher,
    loadChokidar: params.loadChokidar ?? loadChokidar,
    watchPaths: params.watchPaths ?? runNodeWatchedPaths,
    fs: params.fs ?? fs,
  };

  const childEnv = { ...deps.env };
  const watchSession = `${deps.now()}-${deps.process.pid}`;
  const useChildProcessGroup = process.platform !== "win32" && deps.process.stdin?.isTTY !== true;
  childEnv.OPENCLAW_WATCH_MODE = "1";
  childEnv.OPENCLAW_WATCH_SESSION = watchSession;
  // The watcher owns process restarts; keep SIGUSR1/config reloads in-process
  // so inherited launchd/systemd markers do not make the child exit and stall.
  childEnv.OPENCLAW_NO_RESPAWN = "1";
  if (deps.args.length > 0) {
    childEnv.OPENCLAW_WATCH_COMMAND = deps.args.join(" ");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let shuttingDown = false;
    let restartRequested = false;
    let watchProcess = null;
    let watcher = null;
    let lockHandle = null;
    let autoDoctorAttempted = false;
    let shutdownExitCode = null;
    let shutdownKillTimer = null;
    let restartDeferred = false;
    let restartDeferredTimer = null;

    const signalWatchProcess = (child, signal) => {
      if (!child || typeof child.kill !== "function") {
        return;
      }
      if (useChildProcessGroup && typeof child.pid === "number") {
        try {
          deps.signalProcess(-child.pid, signal);
          return;
        } catch (error) {
          if (error?.code === "ESRCH" || error?.code === "EPERM") {
            return;
          }
        }
      }
      child.kill(signal);
    };

    const forceKillWatchProcessGroup = (child) => {
      if (!useChildProcessGroup || typeof child?.pid !== "number") {
        return;
      }
      try {
        deps.signalProcess(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") {
          throw error;
        }
      }
    };

    const settle = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (shutdownKillTimer) {
        clearTimeout(shutdownKillTimer);
      }
      if (restartDeferredTimer) {
        clearInterval(restartDeferredTimer);
        restartDeferredTimer = null;
      }
      if (onSigInt) {
        deps.process.off("SIGINT", onSigInt);
      }
      if (onSigTerm) {
        deps.process.off("SIGTERM", onSigTerm);
      }
      releaseWatchLock(lockHandle);
      watcher?.close?.().catch?.(() => {});
      resolve(code);
    };

    const requestShutdown = (code) => {
      shuttingDown = true;
      shutdownExitCode = code;
      if (!watchProcess || typeof watchProcess.kill !== "function") {
        settle(code);
        return;
      }
      const shutdownProcess = watchProcess;
      signalWatchProcess(shutdownProcess, WATCH_RESTART_SIGNAL);
      shutdownKillTimer ??= setTimeout(() => {
        shutdownKillTimer = null;
        signalWatchProcess(shutdownProcess, "SIGKILL");
      }, WATCH_SHUTDOWN_KILL_GRACE_MS);
    };

    const settleIfShuttingDown = (exitedProcess) => {
      if (!shuttingDown || shutdownExitCode === null) {
        return false;
      }
      forceKillWatchProcessGroup(exitedProcess);
      settle(shutdownExitCode);
      return true;
    };

    const startRunner = () => {
      watchProcess = deps.spawn(deps.process.execPath, buildRunnerArgs(deps.args), {
        cwd: deps.cwd,
        detached: useChildProcessGroup,
        env: childEnv,
        stdio: "inherit",
      });
      watchProcess.on("error", (error) => {
        watchProcess = null;
        logWatcher(`Failed to spawn watcher child: ${error?.message ?? "unknown error"}`, deps);
        settle(1);
      });
      watchProcess.on("exit", (exitCode, exitSignal) => {
        const exitedProcess = watchProcess;
        watchProcess = null;
        if (settled) {
          return;
        }
        if (settleIfShuttingDown(exitedProcess)) {
          return;
        }
        if (restartRequested || shouldRestartAfterChildExit(exitCode, exitSignal)) {
          // Don't restart into a broken build — verify the replacement build
          // is valid for the current checkout before spawning a new child
          // (issue #99603).
          if (!isBuildReadyForRestart(deps.cwd, deps.fs)) {
            logWatcher(
              "Build not ready after child exit — settling to avoid crash-loop; " +
                "systemd will restart the gateway cleanly",
              deps,
            );
            settle(exitCode ?? 1);
            return;
          }
          forceKillWatchProcessGroup(exitedProcess);
          restartRequested = false;
          startRunner();
          return;
        }
        if (shouldRunAutoDoctor(deps, autoDoctorAttempted)) {
          runAutoDoctorAndRestart();
          return;
        }
        settle(exitSignal ? 1 : (exitCode ?? 1));
      });
    };

    const handleWatcherError = () => {
      requestShutdown(1);
    };

    const rejectWatcherStartupError = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);
      }
      releaseWatchLock(lockHandle);
      watcher?.close?.().catch?.(() => {});
      if (onSigInt) {
        deps.process.off("SIGINT", onSigInt);
      }
      if (onSigTerm) {
        deps.process.off("SIGTERM", onSigTerm);
      }
      reject(toLintErrorObject(err, "Non-Error rejection"));
    };

    const resolveCreateWatcher = async () => {
      try {
        const chokidarModule = await deps.loadChokidar();
        return (watchPaths, options) => chokidarModule.watch(watchPaths, options);
      } catch (err) {
        if (isInvalidPackageConfigError(err)) {
          printFriendlyWatchStartupError(err);
        }
        throw err;
      }
    };

    const runAutoDoctorAndRestart = () => {
      autoDoctorAttempted = true;
      logWatcher(
        "Gateway exited early; running `openclaw doctor --fix --non-interactive` once.",
        deps,
      );
      watchProcess = deps.spawn(deps.process.execPath, buildDoctorRunnerArgs(), {
        cwd: deps.cwd,
        detached: useChildProcessGroup,
        env: childEnv,
        stdio: "inherit",
      });
      watchProcess.on("error", (error) => {
        watchProcess = null;
        logWatcher(`Failed to spawn doctor repair: ${error?.message ?? "unknown error"}`, deps);
        settle(1);
      });
      watchProcess.on("exit", (exitCode, exitSignal) => {
        const exitedProcess = watchProcess;
        watchProcess = null;
        if (settled) {
          return;
        }
        if (settleIfShuttingDown(exitedProcess)) {
          return;
        }
        if (exitCode === 0 && !exitSignal) {
          logWatcher("Doctor repair completed; restarting gateway watch child.", deps);
          startRunner();
          return;
        }
        logWatcher(
          `Doctor repair failed; gateway:watch exiting with code ${exitSignal ? 1 : (exitCode ?? 1)}.`,
          deps,
        );
        settle(exitSignal ? 1 : (exitCode ?? 1));
      });
    };

    const startDeferredPolling = () => {
      if (restartDeferredTimer) return;
      restartDeferred = true;
      restartDeferredTimer = setInterval(() => {
        if (settled || shuttingDown) {
          clearInterval(restartDeferredTimer);
          restartDeferredTimer = null;
          restartDeferred = false;
          return;
        }
        if (isBuildReadyForRestart(deps.cwd, deps.fs)) {
          clearInterval(restartDeferredTimer);
          restartDeferredTimer = null;
          restartDeferred = false;
          logWatcher("Build output ready — triggering deferred restart", deps);
          if (!watchProcess) {
            startRunner();
          } else {
            restartRequested = true;
            signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);
          }
        }
      }, 1000);
    };

    const requestRestart = (changedPath) => {
      if (shuttingDown || isIgnoredWatchPath(changedPath, deps.cwd, deps.watchPaths)) {
        return;
      }
      if (!watchProcess) {
        startRunner();
        return;
      }
      if (restartDeferred) {
        // Already polling — no need to re-enter
        return;
      }
      if (!isBuildReadyForRestart(deps.cwd, deps.fs)) {
        logWatcher(
          "Build not ready — deferring restart until build output is complete " +
            "(current process is still healthy; issue #99603)",
          deps,
        );
        startDeferredPolling();
        return;
      }
      restartRequested = true;
      if (typeof watchProcess.kill === "function") {
        signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);
      }
    };

    const attachWatcher = (createWatcher) => {
      if (settled) {
        return;
      }
      watcher = createWatcher(deps.watchPaths, {
        ignoreInitial: true,
        ignored: (watchPath, stats) =>
          isIgnoredWatchPath(watchPath, deps.cwd, deps.watchPaths, stats),
      });
      watcher.on("add", requestRestart);
      watcher.on("change", requestRestart);
      watcher.on("unlink", requestRestart);
      watcher.on("error", handleWatcherError);
    };

    const startWatcher = () => {
      if (deps.createWatcher) {
        attachWatcher(deps.createWatcher);
        return;
      }
      void resolveCreateWatcher().then(attachWatcher).catch(rejectWatcherStartupError);
    };

    const onSigInt = () => {
      requestShutdown(130);
    };
    const onSigTerm = () => {
      requestShutdown(143);
    };

    deps.process.on("SIGINT", onSigInt);
    deps.process.on("SIGTERM", onSigTerm);

    if (deps.lockDisabled) {
      lockHandle = { lockPath: "", pid: deps.process.pid };
      startRunner();
      startWatcher();
      return;
    }

    void acquireWatchLock(deps, watchSession)
      .then((handle) => {
        if (!handle) {
          settle(1);
          return;
        }
        lockHandle = handle;
        startRunner();
        startWatcher();
      })
      .catch(
        /** @param {unknown} error */ (error) => {
          logWatcher(`Failed to acquire watcher lock: ${error?.message ?? "unknown error"}`, deps);
          settle(1);
        },
      );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runWatchMain()
    .then((code) => process.exit(code))
    .catch(
      /** @param {unknown} err */ (err) => {
        if (!isInvalidPackageConfigError(err)) {
          console.error(err);
        }
        process.exit(1);
      },
    );
}

function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
