import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_STATE_DIR,
} from "./constants.js";

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

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionWriteLock({ sessionFile: registryPath });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function readRegistryFromFile<T>(
  registryPath: string,
  mode: RegistryReadMode,
): Promise<{ entries: T[] }> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (parsed && Array.isArray(parsed.entries)) {
      return { entries: parsed.entries as T[] };
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

async function writeRegistryFile<T>(
  registryPath: string,
  registry: { entries: T[] },
): Promise<void> {
  await fs.mkdir(SANDBOX_STATE_DIR, { recursive: true });
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  const registryDir = path.dirname(registryPath);
  const tempPath = path.join(
    registryDir,
    `${path.basename(registryPath)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, payload, "utf-8");
  try {
    await fs.rename(tempPath, registryPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function readRegistry(): Promise<SandboxRegistry> {
  return await readRegistryFromFile<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, "fallback");
}

async function readRegistryForWrite(): Promise<SandboxRegistry> {
  return await readRegistryFromFile<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, "strict");
}

async function writeRegistry(registry: SandboxRegistry) {
  await writeRegistryFile<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, registry);
}

export async function updateRegistry(entry: SandboxRegistryEntry) {
  await withRegistryLock(SANDBOX_REGISTRY_PATH, async () => {
    const registry = await readRegistryForWrite();
    const existing = registry.entries.find((item) => item.containerName === entry.containerName);
    const next = registry.entries.filter((item) => item.containerName !== entry.containerName);
    next.push({
      ...entry,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
      image: existing?.image ?? entry.image,
      configHash: entry.configHash ?? existing?.configHash,
    });
    await writeRegistry({ entries: next });
  });
}

export async function removeRegistryEntry(containerName: string) {
  await withRegistryLock(SANDBOX_REGISTRY_PATH, async () => {
    const registry = await readRegistryForWrite();
    const next = registry.entries.filter((item) => item.containerName !== containerName);
    if (next.length === registry.entries.length) {
      return;
    }
    await writeRegistry({ entries: next });
  });
}

export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return await readRegistryFromFile<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    "fallback",
  );
}

async function readBrowserRegistryForWrite(): Promise<SandboxBrowserRegistry> {
  return await readRegistryFromFile<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    "strict",
  );
}

async function writeBrowserRegistry(registry: SandboxBrowserRegistry) {
  await writeRegistryFile<SandboxBrowserRegistryEntry>(SANDBOX_BROWSER_REGISTRY_PATH, registry);
}

export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  await withRegistryLock(SANDBOX_BROWSER_REGISTRY_PATH, async () => {
    const registry = await readBrowserRegistryForWrite();
    const existing = registry.entries.find((item) => item.containerName === entry.containerName);
    const next = registry.entries.filter((item) => item.containerName !== entry.containerName);
    next.push({
      ...entry,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
      image: existing?.image ?? entry.image,
      configHash: entry.configHash ?? existing?.configHash,
    });
    await writeBrowserRegistry({ entries: next });
  });
}

export async function removeBrowserRegistryEntry(containerName: string) {
  await withRegistryLock(SANDBOX_BROWSER_REGISTRY_PATH, async () => {
    const registry = await readBrowserRegistryForWrite();
    const next = registry.entries.filter((item) => item.containerName !== containerName);
    if (next.length === registry.entries.length) {
      return;
    }
    await writeBrowserRegistry({ entries: next });
  });
}
