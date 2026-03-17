import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ForkMeta, CreatedMeta, LocalStrategy, StrategyPerformance } from "./types.js";

const STRATEGIES_DIRNAME = "strategies";
const FORK_META_FILENAME = ".fork-meta.json";
const CREATED_META_FILENAME = ".created-meta.json";
const FEP_FILENAME = "fep.yaml";

/**
 * Get the root strategies directory.
 * Default: ~/.openfinclaw/strategies/
 * Also checks legacy ~/.openclaw/strategies/
 */
export function getStrategiesRoot(): string {
  const home = homedir();
  const newDir = path.join(home, ".openfinclaw", STRATEGIES_DIRNAME);
  const legacyDir = path.join(home, ".openclaw", STRATEGIES_DIRNAME);

  if (fs.existsSync(newDir)) {
    return newDir;
  }
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  return newDir;
}

/**
 * Generate a slugified directory name from strategy name.
 * - Lowercase
 * - Spaces/underscores to hyphens
 * - Remove special characters
 * - Max 40 characters
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Extract short ID (first 8 chars) from full UUID.
 */
export function extractShortId(uuid: string): string {
  const match = /^([a-f0-9]{8})/i.exec(uuid);
  return match ? match[1].toLowerCase() : uuid.slice(0, 8).toLowerCase();
}

/**
 * Generate directory name for a forked strategy.
 * Format: {slugified-name}-{short-id}
 */
export function generateForkDirName(name: string, sourceId: string): string {
  const slug = slugifyName(name);
  const shortId = extractShortId(sourceId);
  return `${slug}-${shortId}`;
}

/**
 * Generate directory name for a created strategy.
 * Format: {slugified-name}
 */
export function generateCreatedDirName(name: string): string {
  return slugifyName(name);
}

/**
 * Create date directory under strategies root.
 * Returns the full path to the date directory.
 */
export function createDateDir(baseDir: string, date?: string): string {
  const dateStr = date ?? formatDate(new Date());
  const datePath = path.join(baseDir, dateStr);
  fs.mkdirSync(datePath, { recursive: true });
  return datePath;
}

/**
 * Format date as YYYY-MM-DD.
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Check if a directory is a valid strategy directory.
 */
export function isStrategyDir(dirPath: string): boolean {
  const fepPath = path.join(dirPath, FEP_FILENAME);
  const forkMetaPath = path.join(dirPath, FORK_META_FILENAME);
  const createdMetaPath = path.join(dirPath, CREATED_META_FILENAME);

  try {
    return (
      fs.existsSync(fepPath) && (fs.existsSync(forkMetaPath) || fs.existsSync(createdMetaPath))
    );
  } catch {
    return false;
  }
}

/**
 * Read fork metadata from a strategy directory.
 */
export function readForkMeta(dirPath: string): ForkMeta | null {
  const metaPath = path.join(dirPath, FORK_META_FILENAME);
  try {
    const content = fs.readFileSync(metaPath, "utf-8");
    return JSON.parse(content) as ForkMeta;
  } catch {
    return null;
  }
}

/**
 * Read created metadata from a strategy directory.
 */
export function readCreatedMeta(dirPath: string): CreatedMeta | null {
  const metaPath = path.join(dirPath, CREATED_META_FILENAME);
  try {
    const content = fs.readFileSync(metaPath, "utf-8");
    return JSON.parse(content) as CreatedMeta;
  } catch {
    return null;
  }
}

/**
 * Write fork metadata to a strategy directory.
 */
export function writeForkMeta(dirPath: string, meta: ForkMeta): void {
  const metaPath = path.join(dirPath, FORK_META_FILENAME);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Write created metadata to a strategy directory.
 */
export function writeCreatedMeta(dirPath: string, meta: CreatedMeta): void {
  const metaPath = path.join(dirPath, CREATED_META_FILENAME);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * List all date directories under strategies root.
 */
export function listDateDirs(): string[] {
  const root = getStrategiesRoot();
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a));
}

/**
 * List all local strategies.
 */
export async function listLocalStrategies(): Promise<LocalStrategy[]> {
  const root = getStrategiesRoot();
  if (!fs.existsSync(root)) {
    return [];
  }

  const strategies: LocalStrategy[] = [];
  const dateDirs = listDateDirs();

  for (const dateDir of dateDirs) {
    const datePath = path.join(root, dateDir);
    const entries = fs.readdirSync(datePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const strategyPath = path.join(datePath, entry.name);
      const localStrategy = await buildLocalStrategy(strategyPath, dateDir);
      if (localStrategy) {
        strategies.push(localStrategy);
      }
    }
  }

  return strategies;
}

/**
 * Build LocalStrategy from a directory path.
 */
async function buildLocalStrategy(dirPath: string, dateDir: string): Promise<LocalStrategy | null> {
  if (!isStrategyDir(dirPath)) {
    return null;
  }

  const forkMeta = readForkMeta(dirPath);
  const createdMeta = readCreatedMeta(dirPath);

  if (forkMeta) {
    return {
      name: path.basename(dirPath),
      displayName: forkMeta.sourceName,
      localPath: dirPath,
      dateDir,
      type: "forked",
      sourceId: forkMeta.sourceId,
      createdAt: forkMeta.forkedAt,
    };
  }

  if (createdMeta) {
    return {
      name: path.basename(dirPath),
      displayName: createdMeta.displayName ?? createdMeta.name,
      localPath: dirPath,
      dateDir,
      type: "created",
      createdAt: createdMeta.createdAt,
    };
  }

  return null;
}

/**
 * Find a local strategy by name or short ID.
 */
export async function findLocalStrategy(nameOrId: string): Promise<LocalStrategy | null> {
  const strategies = await listLocalStrategies();

  const normalized = nameOrId.toLowerCase();

  return (
    strategies.find(
      (s) =>
        s.name.toLowerCase() === normalized ||
        s.name.toLowerCase().startsWith(normalized) ||
        s.sourceId?.toLowerCase().startsWith(normalized) ||
        (s.sourceId && extractShortId(s.sourceId).toLowerCase() === normalized),
    ) ?? null
  );
}

/**
 * Remove a local strategy.
 */
export async function removeLocalStrategy(
  nameOrId: string,
): Promise<{ success: boolean; error?: string }> {
  const strategy = await findLocalStrategy(nameOrId);
  if (!strategy) {
    return { success: false, error: `Strategy not found: ${nameOrId}` };
  }

  try {
    fs.rmSync(strategy.localPath, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parse strategy ID from various formats.
 * Supports: UUID, short ID, Hub URL
 */
export function parseStrategyId(input: string): string {
  const trimmed = input.trim();

  const urlMatch = /strategy\/([a-f0-9-]{36})/i.exec(trimmed);
  if (urlMatch) {
    return urlMatch[1].toLowerCase();
  }

  const shortIdMatch = /^([a-f0-9]{8})$/i.exec(trimmed);
  if (shortIdMatch) {
    return shortIdMatch[1].toLowerCase();
  }

  const uuidMatch = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
    trimmed,
  );
  if (uuidMatch) {
    return uuidMatch[1].toLowerCase();
  }

  return trimmed.toLowerCase();
}
