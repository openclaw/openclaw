import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";

type MemoryWikiLogEntry = {
  type: "init" | "vault-generation" | "ingest" | "okf-import" | "compile" | "lint";
  timestamp: string;
  details?: Record<string, unknown>;
};

const COMPILED_SOURCE_DIRECTORIES = [
  "sources",
  "entities",
  "concepts",
  "syntheses",
  "reports",
] as const;

type MemoryWikiVaultIdentity = {
  vaultGeneration: string | null;
  compiledCacheReservationId: string | null;
  compiledCachePublicationId: string | null;
  compiledCacheSourceGeneration: string | null;
};

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

export async function loadMemoryWikiVaultIdentity(
  vaultRoot: string,
): Promise<MemoryWikiVaultIdentity> {
  const identity: MemoryWikiVaultIdentity = {
    vaultGeneration: null,
    compiledCacheReservationId: null,
    compiledCachePublicationId: null,
    compiledCacheSourceGeneration: null,
  };
  let raw: string;
  try {
    raw = await fs.readFile(path.join(vaultRoot, ".openclaw-wiki", "log.jsonl"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return identity;
    }
    throw error;
  }
  for (const line of raw.split(/\r?\n/)) {
    try {
      const { details } = JSON.parse(line) as MemoryWikiLogEntry;
      identity.vaultGeneration ??= normalizeOptionalString(details?.vaultGeneration) ?? null;
      const normalizedReservationId = normalizeOptionalString(details?.compiledCacheReservationId);
      const candidateCompiledCachePublicationId = normalizeOptionalString(
        details?.compiledCachePublicationId,
      );
      if (candidateCompiledCachePublicationId) {
        const candidateParent = details?.compiledCacheParentPublicationId;
        const normalizedParent =
          candidateParent === null ? null : normalizeOptionalString(candidateParent);
        const normalizedSourceGeneration = normalizeOptionalString(
          details?.compiledCacheSourceGeneration,
        );
        // A commit must reference both the prior publication and a reservation
        // already present in the log; it cannot recreate either after rollback.
        if (
          normalizedParent === identity.compiledCachePublicationId &&
          normalizedReservationId === identity.compiledCacheReservationId &&
          normalizedSourceGeneration
        ) {
          identity.compiledCachePublicationId = candidateCompiledCachePublicationId;
          identity.compiledCacheSourceGeneration = normalizedSourceGeneration;
        }
      } else if (normalizedReservationId) {
        identity.compiledCacheReservationId = normalizedReservationId;
      }
    } catch {
      // Audit logs may contain a partial final line after an interrupted append.
    }
  }
  return identity;
}

export async function resolveMemoryWikiVaultSourceGeneration(vaultRoot: string): Promise<string> {
  const files = (
    await Promise.all(
      COMPILED_SOURCE_DIRECTORIES.map((relativeDir) =>
        listMemoryWikiPagePaths(vaultRoot, relativeDir),
      ),
    )
  )
    .flat()
    .toSorted((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = Buffer.from(file);
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(relativePath.byteLength);
    const contentDigest = createHash("sha256")
      .update(await fs.readFile(path.join(vaultRoot, file)))
      .digest();
    hash.update(pathLength).update(relativePath).update(contentDigest);
  }
  return hash.digest("hex");
}

export async function loadMemoryWikiValidatedVaultIdentity(
  vaultRoot: string,
): Promise<MemoryWikiVaultIdentity> {
  const identity = await loadMemoryWikiVaultIdentity(vaultRoot);
  if (!identity.compiledCachePublicationId || !identity.compiledCacheSourceGeneration) {
    return identity;
  }
  if (
    (await resolveMemoryWikiVaultSourceGeneration(vaultRoot)) ===
    identity.compiledCacheSourceGeneration
  ) {
    return identity;
  }
  return {
    ...identity,
    compiledCachePublicationId: null,
    compiledCacheSourceGeneration: null,
  };
}

export async function ensureMemoryWikiVaultGeneration(vaultRoot: string): Promise<string> {
  const { vaultGeneration: existing } = await loadMemoryWikiVaultIdentity(vaultRoot);
  if (existing) {
    return existing;
  }
  const candidate = randomUUID();
  await appendMemoryWikiLog(vaultRoot, {
    type: "vault-generation",
    timestamp: new Date().toISOString(),
    details: { vaultGeneration: candidate },
  });
  // Concurrent initialization can append two candidates. The first durable
  // audit entry owns the vault generation, so every caller converges on it.
  return (await loadMemoryWikiVaultIdentity(vaultRoot)).vaultGeneration ?? candidate;
}
