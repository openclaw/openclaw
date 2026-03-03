import fs from "node:fs/promises";
import { writeJsonAtomic } from "../../infra/json-files.js";
import { resolveProcessScopedMap } from "../../shared/process-scoped-map.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { SANDBOX_BROWSER_REGISTRY_PATH, SANDBOX_REGISTRY_PATH } from "./constants.js";

export type SandboxRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export type SandboxBrowserRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

type RegistryReadMode = "strict" | "fallback";

type RegistryEntry = {
  containerName: string;
};

type RegistryFile<T extends RegistryEntry> = {
  entries: T[];
};

type UpsertEntry = RegistryEntry & {
  createdAtMs: number;
  image: string;
  configHash?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return isRecord(value) && typeof value.containerName === "string";
}

function isRegistryFile<T extends RegistryEntry>(value: unknown): value is RegistryFile<T> {
  if (!isRecord(value)) {
    return false;
  }

  const maybeEntries = value.entries;
  return Array.isArray(maybeEntries) && maybeEntries.every(isRegistryEntry);
}

// Timeout for the registry mutation fn() (read + write). 30 s is generous;
// normal operations complete in <100 ms. If the write stalls (full disk, kernel
// I/O hang, FUSE mount) this prevents the in-process mutex from blocking all
// subsequent registry mutations indefinitely.
const REGISTRY_MUTATION_TIMEOUT_MS = 30_000;

// In-process async mutex per registry path. Eliminates the O(N) retry-storm
// that the file lock caused when 60+ concurrent gateway containers all queued
// on containers.json.lock — each attempt had exponential backoff up to 1 s,
// turning a 30-container burst into 10–30 s waits and timeouts.
//
// The gateway is a single Node.js process, so an in-process promise queue gives
// efficient same-process serialization. Cross-process safety (CLI vs gateway)
// is preserved by also acquiring the file lock inside the in-process mutex:
// since only one caller holds the in-process mutex at a time, the file lock is
// acquired with zero contention from other gateway waiters.
const REGISTRY_MUTEXES_KEY = Symbol.for("openclaw.sandboxRegistryMutexes");
type MutexState = { tail: Promise<void> };

function getRegistryMutex(registryPath: string): MutexState {
  const map = resolveProcessScopedMap<MutexState>(REGISTRY_MUTEXES_KEY);
  let state = map.get(registryPath);
  if (!state) {
    state = { tail: Promise.resolve() };
    map.set(registryPath, state);
  }
  return state;
}

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const mutex = getRegistryMutex(registryPath);
  let release!: () => void;
  const prev = mutex.tail;
  // Chain the next waiter onto the mutex tail before awaiting so concurrent
  // callers always queue in arrival order rather than racing on Promise.resolve.
  mutex.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  // Acquire the file lock for cross-process safety (e.g. `openclaw sandbox
  // recreate` CLI running concurrently with the gateway). Because the
  // in-process mutex above serialises all gateway callers, only one waiter
  // ever contends for the file lock at a time — acquisition is instant.
  const fileLock = await acquireSessionWriteLock({
    sessionFile: registryPath,
    allowReentrant: false,
  });
  try {
    // Race against a timeout so a stalled file write surfaces as an explicit
    // error instead of silently blocking all subsequent mutations.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`registry mutation timed out: ${registryPath}`)),
            REGISTRY_MUTATION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  } finally {
    await fileLock.release();
    release();
  }
}

async function readRegistryFromFile<T extends RegistryEntry>(
  registryPath: string,
  mode: RegistryReadMode,
): Promise<RegistryFile<T>> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRegistryFile<T>(parsed)) {
      return parsed;
    }
    if (mode === "fallback") {
      return { entries: [] };
    }
    throw new Error(`Invalid sandbox registry format: ${registryPath}`);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    if (mode === "fallback") {
      return { entries: [] };
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
  }
}

async function writeRegistryFile<T extends RegistryEntry>(
  registryPath: string,
  registry: RegistryFile<T>,
): Promise<void> {
  await writeJsonAtomic(registryPath, registry, { trailingNewline: true });
}

export async function readRegistry(): Promise<SandboxRegistry> {
  return await readRegistryFromFile<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, "fallback");
}

function upsertEntry<T extends UpsertEntry>(entries: T[], entry: T): T[] {
  const existing = entries.find((item) => item.containerName === entry.containerName);
  const next = entries.filter((item) => item.containerName !== entry.containerName);
  next.push({
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
  });
  return next;
}

function removeEntry<T extends RegistryEntry>(entries: T[], containerName: string): T[] {
  return entries.filter((entry) => entry.containerName !== containerName);
}

async function withRegistryMutation<T extends RegistryEntry>(
  registryPath: string,
  mutate: (entries: T[]) => T[] | null,
): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    const registry = await readRegistryFromFile<T>(registryPath, "strict");
    const next = mutate(registry.entries);
    if (next === null) {
      return;
    }
    await writeRegistryFile(registryPath, { entries: next });
  });
}

export async function updateRegistry(entry: SandboxRegistryEntry) {
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) =>
    upsertEntry(entries, entry),
  );
}

export async function removeRegistryEntry(containerName: string) {
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) => {
    const next = removeEntry(entries, containerName);
    if (next.length === entries.length) {
      return null;
    }
    return next;
  });
}

export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return await readRegistryFromFile<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    "fallback",
  );
}

export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => upsertEntry(entries, entry),
  );
}

export async function removeBrowserRegistryEntry(containerName: string) {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => {
      const next = removeEntry(entries, containerName);
      if (next.length === entries.length) {
        return null;
      }
      return next;
    },
  );
}
