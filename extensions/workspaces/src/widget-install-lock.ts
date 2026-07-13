import { createHash } from "node:crypto";
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";

const WIDGET_INSTALL_LOCK_OPTIONS = {
  retries: {
    retries: 100,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 60_000,
} as const;

const localInstallTails = new Map<string, Promise<void>>();
const LOCK_ROOT = path.posix.join("workspaces", ".widget-install-locks");

async function withLocalWidgetInstallLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = localInstallTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localInstallTails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (localInstallTails.get(key) === tail) {
      localInstallTails.delete(key);
    }
  }
}

/** Serializes all filesystem creation for one custom-widget name. */
export async function withWidgetInstallLock<T>(
  name: string,
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const root = await fsRoot(stateDir, { mkdir: true, symlinks: "reject" });
  await root.mkdir(LOCK_ROOT);
  const lockRoot = await root.resolve(LOCK_ROOT);
  const lockName = createHash("sha256").update(name).digest("hex");
  const lockTarget = path.join(lockRoot, lockName);
  return await withLocalWidgetInstallLock(lockTarget, async () =>
    withFileLock(lockTarget, WIDGET_INSTALL_LOCK_OPTIONS, fn),
  );
}
