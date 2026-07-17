// Memory Wiki plugin module implements log behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";

type MemoryWikiLogEntry = {
  type: "init" | "vault-generation" | "ingest" | "okf-import" | "compile" | "lint";
  timestamp: string;
  details?: Record<string, unknown>;
};

const VAULT_GENERATION_FIELD = "vaultGeneration";

export async function appendMemoryWikiLog(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
): Promise<void> {
  const logPath = path.join(vaultRoot, ".openclaw-wiki", "log.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await appendRegularFile({
    filePath: logPath,
    content: `${JSON.stringify(entry)}\n`,
    rejectSymlinkParents: true,
  });
}

export async function loadMemoryWikiVaultGeneration(vaultRoot: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(vaultRoot, ".openclaw-wiki", "log.jsonl"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  for (const line of raw.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as MemoryWikiLogEntry;
      const generation = parsed.details?.[VAULT_GENERATION_FIELD];
      if (typeof generation === "string" && generation.trim()) {
        return generation.trim();
      }
    } catch {
      // Audit logs may contain a partial final line after an interrupted append.
    }
  }
  return null;
}

export async function ensureMemoryWikiVaultGeneration(vaultRoot: string): Promise<string> {
  const existing = await loadMemoryWikiVaultGeneration(vaultRoot);
  if (existing) {
    return existing;
  }
  const candidate = randomUUID();
  await appendMemoryWikiLog(vaultRoot, {
    type: "vault-generation",
    timestamp: new Date().toISOString(),
    details: { [VAULT_GENERATION_FIELD]: candidate },
  });
  // Concurrent initialization can append two candidates. The first durable
  // audit entry owns the vault generation, so every caller converges on it.
  return (await loadMemoryWikiVaultGeneration(vaultRoot)) ?? candidate;
}
