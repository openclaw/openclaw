import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCAL_GO_GC = "30";
const DEFAULT_LOCAL_GO_MEMORY_LIMIT = "3GiB";
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_POLL_MS = 500;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function isLocalCheckEnabled(env) {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

export function hasFlag(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

export function applyLocalTsgoPolicy(args, env) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  if (!isLocalCheckEnabled(nextEnv)) {
    return { env: nextEnv, args: nextArgs };
  }

  insertBeforeSeparator(nextArgs, "--singleThreaded");
  insertBeforeSeparator(nextArgs, "--checkers", "1");

  if (!nextEnv.GOGC) {
    nextEnv.GOGC = DEFAULT_LOCAL_GO_GC;
  }
  if (!nextEnv.GOMEMLIMIT) {
    nextEnv.GOMEMLIMIT = DEFAULT_LOCAL_GO_MEMORY_LIMIT;
  }
  if (nextEnv.OPENCLAW_TSGO_PPROF_DIR && !hasFlag(nextArgs, "--pprofDir")) {
    insertBeforeSeparator(nextArgs, "--pprofDir", nextEnv.OPENCLAW_TSGO_PPROF_DIR);
  }

  return { env: nextEnv, args: nextArgs };
}

export function applyLocalOxlintPolicy(args, env) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  insertBeforeSeparator(nextArgs, "--type-aware");
  insertBeforeSeparator(nextArgs, "--tsconfig", "tsconfig.oxlint.json");

  if (isLocalCheckEnabled(nextEnv)) {
    insertBeforeSeparator(nextArgs, "--threads=1");
  }

  return { env: nextEnv, args: nextArgs };
}

export function acquireLocalHeavyCheckLockSync(params) {
  const env = params.env ?? process.env;

  if (!isLocalCheckEnabled(env)) {
    return () => {};
  }

  const commonDir = resolveGitCommonDir(params.cwd);
  const locksDir = path.join(commonDir, "openclaw-local-checks");
  const lockDir = path.join(locksDir, `${params.lockName ?? "heavy-check"}.lock`);
  const ownerPath = path.join(lockDir, "owner.json");
  const timeoutMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
  );
  const pollMs = readPositiveInt(env.OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS, DEFAULT_LOCK_POLL_MS);
  const staleLockMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_STALE_LOCK_MS,
    DEFAULT_STALE_LOCK_MS,
  );
  const startedAt = Date.now();
  let waitingLogged = false;

  fs.mkdirSync(locksDir, { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      writeOwnerFile(ownerPath, {
        pid: process.pid,
        tool: params.toolName,
        cwd: params.cwd,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      });
      return () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const owner = readOwnerFile(ownerPath);
      if (shouldReclaimLock({ owner, lockDir, staleLockMs })) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        const ownerLabel = describeOwner(owner);
        throw new Error(
          `[${params.toolName}] timed out waiting for the local heavy-check lock at ${lockDir}${
            ownerLabel ? ` (${ownerLabel})` : ""
          }. If no local heavy checks are still running, remove the stale lock and retry.`,
          { cause: error },
        );
      }

      if (!waitingLogged) {
        const ownerLabel = describeOwner(owner);
        console.error(
          `[${params.toolName}] waiting for the local heavy-check lock${
            ownerLabel ? ` held by ${ownerLabel}` : ""
          }...`,
        );
        waitingLogged = true;
      }

      sleepSync(pollMs);
    }
  }
}

export function resolveGitCommonDir(cwd) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) {
    const raw = result.stdout.trim();
    if (raw.length > 0) {
      return path.resolve(cwd, raw);
    }
  }

  return path.join(cwd, ".git");
}

function insertBeforeSeparator(args, ...items) {
  if (items.length > 0 && hasFlag(args, items[0])) {
    return;
  }

  const separatorIndex = args.indexOf("--");
  const insertIndex = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(insertIndex, 0, ...items);
}

function readPositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeOwnerFile(ownerPath, owner) {
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function readOwnerFile(ownerPath) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function shouldReclaimLock({ owner, lockDir, staleLockMs }) {
  if (owner && typeof owner.pid === "number") {
    return !isProcessAlive(owner.pid);
  }

  try {
    const stats = fs.statSync(lockDir);
    return Date.now() - stats.mtimeMs >= staleLockMs;
  } catch {
    return true;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function describeOwner(owner) {
  if (!owner || typeof owner !== "object") {
    return "";
  }

  const tool = typeof owner.tool === "string" ? owner.tool : "unknown-tool";
  const pid = typeof owner.pid === "number" ? `pid ${owner.pid}` : "unknown pid";
  const cwd = typeof owner.cwd === "string" ? owner.cwd : "unknown cwd";
  return `${tool}, ${pid}, cwd ${cwd}`;
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}
