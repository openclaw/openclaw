import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../../infra/json-files.js";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
} from "./constants.js";

export type SandboxRegistryEntry = {
  containerName: string;
  backendId?: string;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
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

type RegistryEntry = {
  containerName: string;
};

type RegistryFile = {
  entries: RegistryEntry[];
};

// Schemas are shared between the per-entry files (live writes) and the
// legacy monolithic files (one-shot migration). Both shapes must validate
// containerName; per-entry files are just the RegistryEntrySchema directly.
const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

// ── Per-entry file primitives ──────────────────────────────────────────
//
// Each container gets its own JSON file under the sharded directory.
// Writes use writeJsonAtomic (tmp + rename) for crash-safety. No file
// locks are needed — each concurrent writer only touches its own file,
// so there is zero cross-session contention on the monolithic lock that
// previously serialized every sandbox ensure/remove in the process tree.

function entryFilePath(dir: string, containerName: string): string {
  return path.join(dir, `${containerName}.json`);
}

async function readEntryFile<T extends RegistryEntry>(
  dir: string,
  containerName: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(entryFilePath(dir, containerName), "utf-8");
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = safeParseJsonWithSchema(RegistryEntrySchema, raw) as T | null;
  return parsed ?? null;
}

async function writeEntryFile(dir: string, entry: RegistryEntry): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(entryFilePath(dir, entry.containerName), entry, { trailingNewline: true });
}

async function removeEntryFile(dir: string, containerName: string): Promise<void> {
  try {
    await fs.rm(entryFilePath(dir, containerName), { force: true });
  } catch {
    // A concurrent remove or a missing file is fine — force:true already
    // swallows ENOENT; any other error (e.g. permission) is non-fatal here
    // because the caller's intent was "make sure it's gone".
  }
}

/** Scan every per-entry JSON file in a sharded directory. */
async function readAllEntries<T extends RegistryEntry>(dir: string): Promise<T[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: T[] = [];
  await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const raw = await fs.readFile(path.join(dir, name), "utf-8");
          const parsed = safeParseJsonWithSchema(RegistryEntrySchema, raw) as T | null;
          if (parsed) {
            entries.push(parsed);
          }
          // Corrupt / partially-written files are skipped rather than
          // aborting the whole read: one bad entry should not hide every
          // other container the operator has running.
        } catch {
          // ignore unreadable files for the same reason
        }
      }),
  );
  return entries;
}

// ── One-shot migration from monolithic file → per-entry files ──────────

async function migrateMonolithicIfNeeded(oldPath: string, newDir: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(oldPath, "utf-8");
  } catch {
    // Old file does not exist (already migrated on a previous boot, or
    // fresh install). Nothing to do.
    return;
  }
  const parsed = safeParseJsonWithSchema(RegistryFileSchema, raw) as RegistryFile | null;
  if (!parsed || parsed.entries.length === 0) {
    // Corrupt or empty — drop it (and its stale lock) so we don't re-attempt
    // migration every read.
    await fs.rm(oldPath, { force: true }).catch(() => {});
    await fs.rm(`${oldPath}.lock`, { force: true }).catch(() => {});
    return;
  }
  await fs.mkdir(newDir, { recursive: true });
  await Promise.all(
    parsed.entries.map((entry) =>
      writeJsonAtomic(entryFilePath(newDir, entry.containerName), entry, {
        trailingNewline: true,
      }),
    ),
  );
  // Migration succeeded: remove the monolithic file and any leftover lock
  // file from the previous single-writer scheme.
  await fs.rm(oldPath, { force: true }).catch(() => {});
  await fs.rm(`${oldPath}.lock`, { force: true }).catch(() => {});
}

// ── Public API: Container Registry ─────────────────────────────────────

export async function readRegistry(): Promise<SandboxRegistry> {
  await migrateMonolithicIfNeeded(SANDBOX_REGISTRY_PATH, SANDBOX_CONTAINERS_DIR);
  const entries = await readAllEntries<SandboxRegistryEntry>(SANDBOX_CONTAINERS_DIR);
  return { entries: entries.map(normalizeSandboxRegistryEntry) };
}

/**
 * Read a single container entry by name.
 *
 * O(1) file read — avoids scanning the entire sharded directory just to
 * look up one container, which is the hot path for `ensureSandboxContainer`.
 */
export async function readRegistryEntry(
  containerName: string,
): Promise<SandboxRegistryEntry | null> {
  await migrateMonolithicIfNeeded(SANDBOX_REGISTRY_PATH, SANDBOX_CONTAINERS_DIR);
  const entry = await readEntryFile<SandboxRegistryEntry>(SANDBOX_CONTAINERS_DIR, containerName);
  return entry ? normalizeSandboxRegistryEntry(entry) : null;
}

export async function updateRegistry(entry: SandboxRegistryEntry): Promise<void> {
  await migrateMonolithicIfNeeded(SANDBOX_REGISTRY_PATH, SANDBOX_CONTAINERS_DIR);
  const existing = await readEntryFile<SandboxRegistryEntry>(
    SANDBOX_CONTAINERS_DIR,
    entry.containerName,
  );
  const merged: SandboxRegistryEntry = {
    ...entry,
    backendId: entry.backendId ?? existing?.backendId,
    runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
    configHash: entry.configHash ?? existing?.configHash,
  };
  await writeEntryFile(SANDBOX_CONTAINERS_DIR, merged);
}

export async function removeRegistryEntry(containerName: string): Promise<void> {
  await removeEntryFile(SANDBOX_CONTAINERS_DIR, containerName);
}

// ── Public API: Browser Registry ───────────────────────────────────────

export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  await migrateMonolithicIfNeeded(SANDBOX_BROWSER_REGISTRY_PATH, SANDBOX_BROWSERS_DIR);
  return { entries: await readAllEntries<SandboxBrowserRegistryEntry>(SANDBOX_BROWSERS_DIR) };
}

export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry): Promise<void> {
  await migrateMonolithicIfNeeded(SANDBOX_BROWSER_REGISTRY_PATH, SANDBOX_BROWSERS_DIR);
  const existing = await readEntryFile<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSERS_DIR,
    entry.containerName,
  );
  const merged: SandboxBrowserRegistryEntry = {
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
  };
  await writeEntryFile(SANDBOX_BROWSERS_DIR, merged);
}

export async function removeBrowserRegistryEntry(containerName: string): Promise<void> {
  await removeEntryFile(SANDBOX_BROWSERS_DIR, containerName);
}
