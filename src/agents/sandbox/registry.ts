import { getDatastore } from "../../infra/datastore.js";
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

function readRegistryData<T extends RegistryEntry>(
  registryPath: string,
  mode: RegistryReadMode,
): RegistryFile<T> {
  const parsed = getDatastore().readJson(registryPath);
  if (parsed == null) {
    return { entries: [] };
  }
  if (isRegistryFile<T>(parsed)) {
    return parsed;
  }
  if (mode === "fallback") {
    return { entries: [] };
  }
  throw new Error(`Invalid sandbox registry format: ${registryPath}`);
}

export function readRegistry(): SandboxRegistry {
  return readRegistryData<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, "fallback");
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
  await getDatastore().updateJsonWithLock(registryPath, (data) => {
    if (data != null && !isRegistryFile<T>(data)) {
      throw new Error(`Invalid sandbox registry format: ${registryPath}`);
    }
    const registry: RegistryFile<T> = (data as RegistryFile<T> | null) ?? { entries: [] };
    const next = mutate(registry.entries);
    if (next === null) {
      return { changed: false, result: registry };
    }
    return { changed: true, result: { entries: next } };
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

export function readBrowserRegistry(): SandboxBrowserRegistry {
  return readRegistryData<SandboxBrowserRegistryEntry>(SANDBOX_BROWSER_REGISTRY_PATH, "fallback");
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
