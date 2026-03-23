import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth";

type CommandDeployCache = {
  hash: string;
  updatedAt: number;
};

/**
 * Compute a deterministic SHA-256 hash of the command specs.
 * Sorts specs by name and sorts object keys at every level to ensure
 * the hash is stable regardless of insertion order.
 */
export function computeCommandHash(commandSpecs: NativeCommandSpec[]): string {
  const sorted = [...commandSpecs].sort((a, b) => a.name.localeCompare(b.name));
  const json = JSON.stringify(sorted, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
  return crypto.createHash("sha256").update(json).digest("hex");
}

function resolveCacheFilePath(cacheDir: string, botId: string): string {
  return path.join(cacheDir, `${botId}.json`);
}

/**
 * Returns true if the current command specs match the cached hash on disk,
 * meaning the deploy can be safely skipped.
 * Returns false on any I/O error, missing file, or hash mismatch.
 */
export async function shouldSkipDeploy(
  commandSpecs: NativeCommandSpec[],
  cacheDir: string,
  botId: string,
): Promise<boolean> {
  const hash = computeCommandHash(commandSpecs);
  const file = resolveCacheFilePath(cacheDir, botId);
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "hash" in parsed &&
      typeof (parsed as CommandDeployCache).hash === "string"
    ) {
      return (parsed as CommandDeployCache).hash === hash;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Write the current command hash to the cache file after a successful deploy.
 * Creates the cache directory if it does not exist.
 * Throws on I/O failure — callers should catch and log non-fatally.
 */
export async function updateDeployCache(
  commandSpecs: NativeCommandSpec[],
  cacheDir: string,
  botId: string,
): Promise<void> {
  const hash = computeCommandHash(commandSpecs);
  const file = resolveCacheFilePath(cacheDir, botId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const data: CommandDeployCache = { hash, updatedAt: Date.now() };
  await fs.promises.writeFile(file, JSON.stringify(data), "utf8");
}
