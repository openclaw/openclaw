import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  const emptyIdentity: MemoryWikiVaultIdentity = {
    vaultGeneration: null,
    compiledCacheReservationId: null,
    compiledCachePublicationId: null,
    compiledCacheSourceGeneration: null,
  };
  const identity = { ...emptyIdentity };
  const consumeLine = (line: string) => {
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
  };
  try {
    const handle = await fs.open(path.join(vaultRoot, ".openclaw-wiki", "log.jsonl"), "r");
    try {
      const stat = await handle.stat();
      // Read one finite prefix of the opened journal, not a live tail. Later
      // publication checks still replay independently to detect concurrent writers.
      let remaining = stat.isFile() && stat.size > 0 ? stat.size : Infinity;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const decoder = new StringDecoder("utf8");
      let fragments: string[] = [];
      const consume = (text: string) => {
        let start = 0;
        for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
          const part = text.slice(start, end);
          if (fragments.length > 0) {
            fragments.push(part);
            consumeLine(fragments.join(""));
            fragments = [];
          } else {
            consumeLine(part);
          }
          start = end + 1;
        }
        if (start < text.length) {
          fragments.push(text.slice(start));
        }
      };
      while (remaining > 0) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, remaining),
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        remaining -= bytesRead;
        consume(decoder.write(buffer.subarray(0, bytesRead)));
      }
      consume(decoder.end());
      if (fragments.length > 0) {
        consumeLine(fragments.join(""));
      }
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Memory Wiki journal read and close failed.",
          {
            cause: closeError,
          },
        );
      }
      throw error;
    }
    await handle.close();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyIdentity;
    }
    throw error;
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
  ).flat();
  const entries: Array<[string, Buffer]> = [];
  for (const file of files) {
    const contentDigest = createHash("sha256")
      .update(await fs.readFile(path.join(vaultRoot, file)))
      .digest();
    entries.push([file, contentDigest]);
  }
  return hashMemoryWikiVaultSources(entries);
}

export function hashMemoryWikiVaultSources(entries: Array<[string, Buffer]>): string {
  const hash = createHash("sha256");
  for (const [file, contentDigest] of entries.toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const relativePath = Buffer.from(file);
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(relativePath.byteLength);
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
