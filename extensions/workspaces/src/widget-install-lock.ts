import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { resolveWidgetDir } from "./manifest.js";

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
  const widgetDir = resolveWidgetDir(name, stateDir);
  return await withLocalWidgetInstallLock(widgetDir, async () =>
    withFileLock(widgetDir, WIDGET_INSTALL_LOCK_OPTIONS, fn),
  );
}
