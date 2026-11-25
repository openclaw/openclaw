import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHROME_SINGLETON_LOCK_PATHS = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;

export type ChromeSingletonLock =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "owner"; hostname: string; pid: number };

export async function readSingletonLockTarget(userDataDir: string): Promise<ChromeSingletonLock> {
  let target: string;
  try {
    target = await fs.readlink(path.join(userDataDir, "SingletonLock"));
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: "Chromium profile lock could not be read" };
  }
  const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) {
    return { status: "invalid", reason: "Chromium profile lock is malformed" };
  }
  const hostname = normalizeOptionalString(match.groups.lockHost) ?? "";
  const pid = Number.parseInt(match.groups.pid ?? "", 10);
  if (!hostname || !Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "invalid", reason: "Chromium profile lock is malformed" };
  }
  return { status: "owner", hostname, pid };
}

export function unverifiedSingletonLockReason(lock: ChromeSingletonLock): string | undefined {
  if (lock.status === "invalid") {
    return lock.reason;
  }
  if (lock.status === "owner" && lock.hostname !== os.hostname()) {
    return "Chromium profile lock names another hostname";
  }
  return undefined;
}

async function clearChromeSingletonArtifacts(userDataDir: string) {
  for (const basename of CHROME_SINGLETON_LOCK_PATHS) {
    try {
      await fs.rm(path.join(userDataDir, basename), { force: true });
    } catch {
      // ignore best-effort cleanup
    }
  }
}

export async function clearStaleChromeSingletonLocks(
  userDataDir: string,
  expectedOwner?: { pid: number; hostname: string },
): Promise<boolean> {
  const lock = await readSingletonLockTarget(userDataDir);
  if (
    lock.status !== "owner" ||
    lock.hostname !== (expectedOwner?.hostname ?? os.hostname()) ||
    (expectedOwner && lock.pid !== expectedOwner.pid) ||
    isPidAlive(lock.pid)
  ) {
    return false;
  }

  await clearChromeSingletonArtifacts(userDataDir);
  return true;
}

export async function clearRecoveredChromeSingletonArtifacts(
  userDataDir: string,
  stoppedPid: number,
  expectedLock: ChromeSingletonLock,
): Promise<boolean> {
  if (isPidAlive(stoppedPid)) {
    return false;
  }
  if ((await readSingletonLockTarget(userDataDir)).status === "missing") {
    return true;
  }
  // A shell can inherit a dead full-Chromium lock with a different PID.
  // Only the captured local owner may be cleared after the stopped process exits.
  return (
    expectedLock.status === "owner" &&
    expectedLock.hostname === os.hostname() &&
    (await clearStaleChromeSingletonLocks(userDataDir, expectedLock))
  );
}
