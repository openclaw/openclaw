// The node supervisor must select its runtime before importing config or SQLite.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHILD_ARGUMENT = "--openclaw-node-host-child";
const MANAGED_CHILD_ARGUMENT = "--openclaw-node-host-managed-child";
const CHILD_MARKER = Symbol.for("openclaw.node-host.launcher-child");
const MANAGED_STATE_MARKER = Symbol.for("openclaw.node-host.managed-state-path");
const RESTART_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const READY_TIMEOUT_MS = 5 * 60 * 1_000;
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const normalize = (value) => {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
};

function parseInvocation(args, env) {
  const words = [];
  const rootArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    if (["--help", "-h", "--version", "-V", "-v"].includes(arg)) {
      return null;
    }
    if (arg === "--ephemeral") {
      return null;
    }
    const [flag, ...parts] = arg.split("=");
    if (flag === "--container" || normalize(env.OPENCLAW_CONTAINER)) {
      return null;
    }
    if (ROOT_VALUE_FLAGS.has(flag)) {
      const rawValue = parts.length ? parts.join("=") : args[++index];
      const value = rawValue?.trim();
      if (!value || value.startsWith("-")) {
        return null;
      }
      rootArgs.push(arg, ...(parts.length ? [] : [rawValue]));
      continue;
    }
    if (ROOT_BOOLEAN_FLAGS.has(arg)) {
      rootArgs.push(arg);
      continue;
    }
    if (words.length === 1 && words[0] === "node") {
      if (flag === "--commands") {
        if (!parts.length) {
          index += 1;
        }
        continue;
      }
      if (arg === "--all-commands") {
        continue;
      }
    }
    words.push(arg);
  }
  const nodeRun = words[0] === "node" && words[1] === "run";
  const connect = words[0] === "connect" && !words.includes("--service");
  return nodeRun || connect ? { rootArgs } : null;
}

function readPackage(packageRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "openclaw" || typeof manifest.version !== "string") {
    throw new Error("The selected node runtime is not an OpenClaw package.");
  }
  return manifest;
}

function resolveManagedRuntime(runtimeRoot, runtimeDirectory, expectedVersion) {
  const releases = realpathSync(path.join(runtimeDirectory, "releases"));
  const resolved = realpathSync(runtimeRoot);
  if (path.dirname(resolved) !== releases) {
    throw new Error("The selected node runtime is outside the managed releases directory.");
  }
  const packageRoot = [
    path.join(resolved, "lib", "node_modules", "openclaw"),
    path.join(resolved, "node_modules", "openclaw"),
  ].find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!packageRoot || !realpathSync(packageRoot).startsWith(`${resolved}${path.sep}`)) {
    throw new Error("The selected node runtime has no private OpenClaw package.");
  }
  const manifest = readPackage(packageRoot);
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error("The selected node runtime version changed before activation.");
  }
  for (const filename of ["openclaw.mjs", "node-host-launcher.mjs"]) {
    if (!existsSync(path.join(packageRoot, filename))) {
      throw new Error(`The selected node runtime is missing ${filename}.`);
    }
  }
  if (
    !existsSync(path.join(packageRoot, "dist", "entry.js")) &&
    !existsSync(path.join(packageRoot, "dist", "entry.mjs"))
  ) {
    throw new Error("The selected node runtime is missing its built entry point.");
  }
  return {
    runtimeRoot: resolved,
    packageRoot,
    manifest,
    entryPath: path.join(packageRoot, "openclaw.mjs"),
  };
}

function resolveCurrentRuntime(runtimeDirectory) {
  // A Windows junction swap can leave the previous selector until publication completes.
  // Retry current after the backup in case a concurrent publisher finished between reads.
  for (const name of ["current", "current.previous", "current"]) {
    const selector = path.join(runtimeDirectory, name);
    try {
      const activatedAt = lstatSync(selector).mtimeMs;
      return { ...resolveManagedRuntime(selector, runtimeDirectory), activatedAt };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return undefined;
}

function assertCompatibleSchemas(previous, candidate) {
  const before = previous.openclaw?.schemaVersions;
  const after = candidate.openclaw?.schemaVersions;
  if (
    !before ||
    !after ||
    !Number.isInteger(before.state) ||
    !Number.isInteger(before.agent) ||
    before.state !== after.state ||
    before.agent !== after.agent
  ) {
    throw new Error("Automatic node activation cannot change database schema versions.");
  }
}

function claimActivation(runtimeDirectory) {
  mkdirSync(runtimeDirectory, { recursive: true });
  const lock = path.join(runtimeDirectory, "activation.lock");
  const owner = `${process.pid}:${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    throw new Error(
      `A node activation lock already exists at ${lock}. If no node update is running, remove that stale lock and retry.`,
      { cause: error },
    );
  }
  const identity = fstatSync(descriptor);
  try {
    writeFileSync(descriptor, owner);
  } finally {
    closeSync(descriptor);
  }
  return () => {
    try {
      const observed = lstatSync(lock);
      if (
        observed.dev === identity.dev &&
        observed.ino === identity.ino &&
        readFileSync(lock, "utf8") === owner
      ) {
        unlinkSync(lock);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        process.stderr.write(
          `openclaw: could not release node activation lock: ${error.message}\n`,
        );
      }
    }
  };
}

function assertRestartInterval(runtimeDirectory, lastAcceptedRestartAt) {
  if (
    lastAcceptedRestartAt !== undefined &&
    performance.now() - lastAcceptedRestartAt < RESTART_INTERVAL_MS
  ) {
    throw new Error("An automatic node restart was attempted within the last 12 hours.");
  }
  const current = resolveCurrentRuntime(runtimeDirectory);
  if (current && Date.now() - current.activatedAt < RESTART_INTERVAL_MS) {
    throw new Error("A node runtime was activated within the last 12 hours.");
  }
}

function activateRuntime(currentPath, runtimeRoot) {
  const temporary = `${currentPath}.${process.pid}.next`;
  const previous = `${currentPath}.previous`;
  const removePrevious = () => {
    try {
      unlinkSync(previous);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  };
  try {
    symlinkSync(runtimeRoot, temporary, process.platform === "win32" ? "junction" : "dir");
    try {
      renameSync(temporary, currentPath);
    } catch (error) {
      if (
        !["EPERM", "EACCES", "EEXIST", "ENOTEMPTY"].includes(error.code) ||
        !lstatSync(currentPath, { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        throw error;
      }
      // Windows cannot replace a directory junction. Keep its timestamp and target recoverable.
      removePrevious();
      renameSync(currentPath, previous);
      try {
        renameSync(temporary, currentPath);
      } catch (publishError) {
        try {
          renameSync(previous, currentPath);
        } catch (restoreError) {
          throw new AggregateError(
            [publishError, restoreError],
            `${publishError.message}; could not restore the previous selector at ${previous}: ${restoreError.message}`,
            { cause: restoreError },
          );
        }
        throw publishError;
      }
    }
    try {
      removePrevious();
    } catch (error) {
      // The new selector is committed; a later activation can clean up the backup.
      process.stderr.write(
        `openclaw: could not remove the previous node selector: ${error.message}\n`,
      );
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") {
        process.stderr.write(
          `openclaw: could not remove the staged node selector at ${temporary}: ${error.message}\n`,
        );
      }
    }
  }
}

export const isNodeHostLauncherChild = () => process[CHILD_MARKER] === true;

export async function runNodeHostLauncher({ entryPath, packageRoot }) {
  const managedChild = process.argv[2] === MANAGED_CHILD_ARGUMENT;
  if (process.argv[2] === CHILD_ARGUMENT || managedChild) {
    if (!process.send || !process.connected) {
      throw new Error("The private node launcher argument requires a supervisor connection.");
    }
    const managedStatePath = managedChild ? process.argv[3] : undefined;
    if (managedChild && (!managedStatePath || !path.isAbsolute(managedStatePath))) {
      throw new Error(
        "The private managed node launcher argument requires an absolute state database path.",
      );
    }
    process.argv.splice(2, managedChild ? 2 : 1);
    process[CHILD_MARKER] = true;
    if (managedStatePath) {
      process[MANAGED_STATE_MARKER] = managedStatePath;
    }
    process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
    process.channel?.unref();
    return false;
  }
  if (isNodeHostLauncherChild()) {
    return false;
  }
  const invocation = parseInvocation(process.argv.slice(2), process.env);
  if (
    !invocation ||
    existsSync(path.join(packageRoot, "src", "entry.ts")) ||
    existsSync(path.join(packageRoot, ".git"))
  ) {
    return false;
  }
  const {
    resolveNodeHostLauncherStateDir,
    compareOpenClawReleaseVersions,
    resolveOpenClawStateSqlitePath,
    watchNodeHostParentStdin,
  } = await import(
    pathToFileURL(path.join(packageRoot, "dist", "node-host-launcher-bootstrap.js")).href
  );
  const stateDir = resolveNodeHostLauncherStateDir(process.argv, process.env);
  if (!stateDir) {
    return false;
  }
  const statePath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  const compareVersions = (left, right) => {
    const compared = compareOpenClawReleaseVersions(left, right);
    if (compared === null) {
      throw new Error("The node runtime package has an invalid OpenClaw release version.");
    }
    return compared;
  };
  const runtimeDirectory = path.join(stateDir, "node-runtime");
  const currentPath = path.join(runtimeDirectory, "current");
  let active = { entryPath, packageRoot, manifest: readPackage(packageRoot) };
  const assertCurrentVersionAdvances = (next) => {
    if (compareVersions(next.manifest.version, active.manifest.version) <= 0) {
      throw new Error("The selected node runtime must be newer than the running version.");
    }
    const current = resolveCurrentRuntime(runtimeDirectory);
    if (
      current &&
      compareVersions(current.manifest.version, active.manifest.version) > 0 &&
      compareVersions(next.manifest.version, current.manifest.version) <= 0
    ) {
      throw new Error("Another node already selected this runtime version or a newer one.");
    }
  };
  try {
    const managed = resolveCurrentRuntime(runtimeDirectory);
    // A normal operator update must be able to advance beyond a private runtime.
    if (managed && compareVersions(managed.manifest.version, active.manifest.version) >= 0) {
      active = managed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stderr.write(
        `openclaw: ignoring an invalid managed node runtime: ${error.message}\n`,
      );
    }
  }
  let restartArgs = process.argv.slice(2);
  let childExecArgv = process.execArgv;
  let childEnv = process.env;
  let pending;
  let lastAcceptedRestartAt;
  let releaseActivation;
  let stoppingSignal;
  let child;
  let shutdownTimer;
  const signals =
    process.platform === "win32"
      ? ["SIGTERM", "SIGINT", "SIGBREAK"]
      : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
  const listeners = new Map();
  for (const signal of signals) {
    const listener = () => {
      stoppingSignal ??= signal;
      try {
        child?.kill(signal);
      } catch {
        // A child can finish between signal delivery and forwarding.
      }
      shutdownTimer ??= setTimeout(() => child?.kill("SIGKILL"), 30_000);
      shutdownTimer.unref();
    };
    process.on(signal, listener);
    listeners.set(signal, listener);
  }
  const stopWatchingParent = process.argv.includes("--parent-stdin")
    ? watchNodeHostParentStdin(() => listeners.get("SIGTERM")())
    : () => {};
  try {
    while (!stoppingSignal) {
      let candidate;
      if (pending) {
        try {
          const next = resolveManagedRuntime(
            pending.runtimeRoot,
            runtimeDirectory,
            pending.manifest.version,
          );
          assertCompatibleSchemas(active.manifest, next.manifest);
          assertCurrentVersionAdvances(next);
          candidate = next;
        } catch (error) {
          process.stderr.write(
            `openclaw: staged node runtime changed before restart: ${error.message}\n`,
          );
          pending = undefined;
          releaseActivation?.();
          releaseActivation = undefined;
        }
      }
      const selected = candidate ?? active;
      const childArguments = selected.runtimeRoot
        ? [MANAGED_CHILD_ARGUMENT, statePath]
        : [CHILD_ARGUMENT];
      let ready = false;
      let candidateFailed = false;
      let bootstrap;
      let readyTimer;
      let readyKillTimer;
      const result = await new Promise((resolve, reject) => {
        child = spawn(
          process.execPath,
          [...childExecArgv, selected.entryPath, ...childArguments, ...restartArgs],
          {
            env: childEnv,
            stdio: ["inherit", "inherit", "inherit", "ipc"],
          },
        );
        if (candidate) {
          readyTimer = setTimeout(() => {
            candidateFailed = true;
            process.stderr.write(
              "openclaw: updated node did not reconnect within five minutes; restoring the previous runtime.\n",
            );
            child.kill("SIGTERM");
            readyKillTimer = setTimeout(() => child.kill("SIGKILL"), 30_000);
            readyKillTimer.unref();
          }, READY_TIMEOUT_MS);
          readyTimer.unref();
        }
        child.on("message", (message) => {
          if (!message || typeof message !== "object") {
            return;
          }
          if (
            message.type === "openclaw.node.bootstrap" &&
            !ready &&
            !candidateFailed &&
            !stoppingSignal
          ) {
            if (
              Array.isArray(message.execArgv) &&
              message.execArgv.every((arg) => typeof arg === "string") &&
              message.env &&
              typeof message.env === "object" &&
              Object.values(message.env).every(
                (value) => typeof value === "string" || value === undefined,
              )
            ) {
              bootstrap = { execArgv: message.execArgv, env: message.env };
              child.send({ type: "openclaw.node.bootstrap-result", ok: true }, () => {});
            }
            return;
          }
          if (message.type === "openclaw.node.restart-args") {
            if (
              Array.isArray(message.argv) &&
              message.argv.every((arg) => typeof arg === "string") &&
              message.argv[0] === "node" &&
              message.argv[1] === "run" &&
              parseInvocation(message.argv, process.env)
            ) {
              restartArgs = [...invocation.rootArgs, ...message.argv];
            }
            return;
          }
          if (
            message.type === "openclaw.node.ready" &&
            message.version === selected.manifest.version &&
            !ready &&
            !candidateFailed &&
            !stoppingSignal
          ) {
            clearTimeout(readyTimer);
            if (candidate) {
              try {
                activateRuntime(currentPath, candidate.runtimeRoot);
                process.stderr.write(
                  `openclaw: node auto-update activated ${candidate.manifest.version}\n`,
                );
              } catch (error) {
                process.stderr.write(
                  `openclaw: could not record the updated node runtime: ${error.message}. The connected candidate will keep running, but its selection was not persisted; the next launch may use the previous runtime.\n`,
                );
              }
              // Authenticated readiness already admits work; persistence failure cannot revoke it.
              active = candidate;
              pending = undefined;
              releaseActivation?.();
              releaseActivation = undefined;
            }
            ready = true;
            return;
          }
          if (message.type !== "openclaw.node.restart") {
            return;
          }
          let claimed;
          try {
            if (!ready || pending || stoppingSignal) {
              throw new Error("The node launcher is not ready for an update restart.");
            }
            if (typeof message.runtimeRoot !== "string" || typeof message.version !== "string") {
              throw new Error("The node restart request is missing its runtime identity.");
            }
            claimed = claimActivation(runtimeDirectory);
            assertRestartInterval(runtimeDirectory, lastAcceptedRestartAt);
            const next = resolveManagedRuntime(
              message.runtimeRoot,
              runtimeDirectory,
              message.version,
            );
            assertCompatibleSchemas(active.manifest, next.manifest);
            assertCurrentVersionAdvances(next);
            pending = next;
            releaseActivation = claimed;
            lastAcceptedRestartAt = performance.now();
            child.send({ type: "openclaw.node.restart-result", ok: true }, () => {});
          } catch (error) {
            claimed?.();
            child.send(
              { type: "openclaw.node.restart-result", ok: false, error: error.message },
              () => {},
            );
          }
        });
        child.on(
          "error",
          /** @param {Error} error */
          (error) => {
            if (child.pid === undefined) {
              reject(error);
            }
          },
        );
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(readyTimer);
      clearTimeout(readyKillTimer);
      if (stoppingSignal) {
        process.exitCode = result.code ?? 1;
        break;
      }
      if (bootstrap && result.code === 0 && !result.signal) {
        childExecArgv = bootstrap.execArgv;
        childEnv = bootstrap.env;
        continue;
      }
      if (candidate && !ready) {
        process.stderr.write(
          "openclaw: updated node failed to reconnect; restarting the previous runtime.\n",
        );
        pending = undefined;
        releaseActivation?.();
        releaseActivation = undefined;
        continue;
      }
      if (pending && result.code === 0 && !result.signal) {
        continue;
      }
      process.exitCode = result.code ?? 1;
      stoppingSignal = result.signal;
      break;
    }
  } finally {
    stopWatchingParent();
    clearTimeout(shutdownTimer);
    releaseActivation?.();
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
  }
  if (stoppingSignal && process.platform !== "win32") {
    process.kill(process.pid, stoppingSignal);
  }
  return true;
}
