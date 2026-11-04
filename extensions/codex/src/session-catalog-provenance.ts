import { lstat } from "node:fs/promises";
import path from "node:path";
import { constants, createZstdDecompress } from "node:zlib";
import { root as openSafeFilesystemRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { isJsonObject, type JsonObject } from "./app-server/protocol.js";
import type { CodexCatalogPageDiagnostics } from "./session-catalog-diagnostics.js";
import type { CodexCatalogNativeThread } from "./session-catalog-types.js";

const MAX_SESSION_META_BYTES = 1024 * 1024;
const SESSION_META_READ_CHUNK_BYTES = 64 * 1024;
const MAX_COMPRESSED_META_BYTES = 8 * 1024 * 1024;
const SESSION_META_DEADLINE_MS = 5_000;
const MAX_PROVENANCE_CACHE_ENTRIES = 20_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const provenanceByPath = new Map<string, boolean>();

function cacheProvenance(key: string, value: boolean): void {
  provenanceByPath.delete(key);
  provenanceByPath.set(key, value);
  if (provenanceByPath.size > MAX_PROVENANCE_CACHE_ENTRIES) {
    provenanceByPath.delete(provenanceByPath.keys().next().value!);
  }
}

/** Undefined means the metadata line is not durable enough to cache yet. */
export async function readCodexSessionMeta(
  sessionsRoot: string,
  rolloutPath: string,
  threadId: string,
  options: { canonicalSource?: boolean } = {},
): Promise<JsonObject | null | undefined> {
  const deadline = options.canonicalSource
    ? performance.now() + SESSION_META_DEADLINE_MS
    : Infinity;
  let safeRoot: Awaited<ReturnType<typeof openSafeFilesystemRoot>>;
  try {
    if (options.canonicalSource) {
      const stat = await lstat(sessionsRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return undefined;
      }
    }
    safeRoot = await openSafeFilesystemRoot(sessionsRoot, {
      hardlinks: "reject",
      maxBytes: Number.MAX_SAFE_INTEGER,
      symlinks: "reject",
    });
  } catch {
    // Unavailable metadata cannot establish native provenance.
    return undefined;
  }
  const candidates = rolloutPath.endsWith(".zst")
    ? [rolloutPath, rolloutPath.slice(0, -".zst".length)]
    : [rolloutPath, `${rolloutPath}.zst`];
  for (const candidate of candidates) {
    let opened: Awaited<ReturnType<typeof safeRoot.open>>;
    try {
      opened = await safeRoot.open(path.relative(sessionsRoot, candidate));
    } catch (error) {
      if (isJsonObject(error) && (error.code === "not-found" || error.code === "ENOENT")) {
        continue;
      }
      return undefined;
    }
    try {
      const compressed = candidate.endsWith(".zst");
      if (
        !opened.stat.size ||
        (options.canonicalSource && compressed && opened.stat.size > MAX_COMPRESSED_META_BYTES) ||
        performance.now() >= deadline
      ) {
        return undefined;
      }
      const input = opened.handle.createReadStream({
        autoClose: false,
        highWaterMark: SESSION_META_READ_CHUNK_BYTES,
        end: opened.stat.size - 1,
      });
      const decoder = compressed
        ? createZstdDecompress({
            chunkSize: SESSION_META_READ_CHUNK_BYTES,
            params: options.canonicalSource ? { [constants.ZSTD_d_windowLogMax]: 25 } : undefined,
          })
        : undefined;
      if (decoder) {
        input.on("error", (error) => decoder.destroy(error));
        input.pipe(decoder);
      }
      const reader = decoder ?? input;
      const timer = options.canonicalSource
        ? setTimeout(
            () => reader.destroy(new Error("Codex rollout metadata observation timed out")),
            Math.floor(Math.max(1, deadline - performance.now())),
          )
        : undefined;
      const chunks: Buffer[] = [];
      let bytesReadTotal = 0;
      let line: string | undefined;
      try {
        for await (const value of reader) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          const newline = chunk.indexOf(0x0a);
          const prefix = newline >= 0 ? chunk.subarray(0, newline) : chunk;
          bytesReadTotal += prefix.length;
          if (bytesReadTotal > MAX_SESSION_META_BYTES) {
            return undefined;
          }
          chunks.push(prefix);
          if (newline >= 0) {
            line = utf8Decoder.decode(Buffer.concat(chunks));
            break;
          }
        }
      } finally {
        clearTimeout(timer);
        reader.destroy();
        input.destroy();
      }
      if (!line) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(line);
      if (
        !isJsonObject(parsed) ||
        parsed.type !== "session_meta" ||
        !isJsonObject(parsed.payload)
      ) {
        return null;
      }
      const payload = parsed.payload;
      return payload.id === threadId ? payload : null;
    } catch {
      // Incomplete or unreadable metadata cannot establish native provenance.
      return undefined;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
  return undefined;
}

/** Passive local listing uses native creation provenance, with rollout fallback for older records. */
export async function isOpenClawManagedCodexThread(
  thread: CodexCatalogNativeThread,
  localSessionsRoot: string | undefined,
  diagnostics?: CodexCatalogPageDiagnostics | null,
): Promise<boolean> {
  const started = diagnostics ? performance.now() : 0;
  if (diagnostics) {
    diagnostics.fields.provenanceChecks++;
  }
  try {
    const rolloutPath = thread.path?.trim();
    if (!localSessionsRoot || !rolloutPath) {
      return false;
    }
    if (thread.originator) {
      return thread.originator === "openclaw";
    }
    const cacheKey = `${localSessionsRoot}\0${rolloutPath}`;
    const cached = provenanceByPath.get(cacheKey);
    if (cached !== undefined) {
      if (diagnostics) {
        diagnostics.fields.provenanceCacheHits++;
      }
      return cached;
    }
    if (diagnostics) {
      diagnostics.fields.provenanceReadCalls++;
    }
    const metadata = await readCodexSessionMeta(localSessionsRoot, rolloutPath, thread.id);
    const managed = metadata === undefined ? undefined : metadata?.originator === "openclaw";
    // A missing or still-being-written rollout must not become a permanent false
    // negative. Newly created sessions are additionally covered by the durable
    // ownership store, while a completed metadata line can be cached safely.
    if (managed !== undefined) {
      cacheProvenance(cacheKey, managed);
    }
    return managed ?? false;
  } finally {
    if (diagnostics) {
      diagnostics.fields.provenanceMs =
        (diagnostics.fields.provenanceMs ?? 0) + performance.now() - started;
    }
  }
}
