/**
 * Filesystem-backed storage for files awaiting user consent in the
 * FileConsentCard flow.
 *
 * The in-memory `pending-uploads.ts` store only works when the sender and the
 * webhook handler live in the same Node.js process. The `openclaw message send
 * --media` CLI path sends the consent card from a short-lived CLI process, but
 * the `fileConsent/invoke` callback lands on the long-running gateway/monitor
 * webhook (a different process). Without a shared store, the invoke handler
 * cannot find the pending upload and the accept fails.
 *
 * This module persists pending uploads to disk so any process with access to
 * the msteams state directory can honor the consent callback.
 *
 * Layout under <stateDir>/msteams-pending-uploads/:
 *   index.json         — metadata map keyed by upload id
 *   <uploadId>.blob    — raw file bytes
 *
 * Metadata entries are TTL-pruned on read.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

/** TTL for pending uploads: 5 minutes (matches in-memory store) */
export const PENDING_UPLOAD_FS_TTL_MS = 5 * 60 * 1000;

const STORE_DIRNAME = "msteams-pending-uploads";
const INDEX_FILENAME = "index.json";
const BLOB_EXTENSION = ".blob";

export interface PendingUploadFsEntry {
  id: string;
  filename: string;
  contentType?: string;
  conversationId: string;
  size: number;
  createdAt: number;
}

interface PendingUploadFsIndex {
  version: 1;
  entries: Record<string, PendingUploadFsEntry>;
}

const EMPTY_INDEX: PendingUploadFsIndex = { version: 1, entries: {} };

export interface PendingUploadFsStoreOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  /** Custom absolute directory that will hold the index + blobs. */
  storeDir?: string;
  ttlMs?: number;
}

export interface PendingUploadFsStore {
  store: (params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    conversationId: string;
  }) => Promise<string>;
  get: (id?: string) => Promise<
    | {
        entry: PendingUploadFsEntry;
        buffer: Buffer;
      }
    | undefined
  >;
  remove: (id?: string) => Promise<void>;
  /** Return the current number of entries after pruning expired rows. */
  count: () => Promise<number>;
}

function isSafeUploadId(id: string): boolean {
  // UUIDs are safe; reject anything that could traverse paths.
  return /^[0-9a-f-]{36}$/i.test(id);
}

function blobPath(storeDir: string, id: string): string {
  return path.join(storeDir, `${id}${BLOB_EXTENSION}`);
}

function pruneExpired(
  index: PendingUploadFsIndex,
  nowMs: number,
  ttlMs: number,
): { index: PendingUploadFsIndex; expiredIds: string[] } {
  const kept: Record<string, PendingUploadFsEntry> = {};
  const expired: string[] = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (nowMs - entry.createdAt > ttlMs) {
      expired.push(id);
      continue;
    }
    kept[id] = entry;
  }
  return { index: { version: 1, entries: kept }, expiredIds: expired };
}

async function unlinkBlobIfPresent(storeDir: string, id: string): Promise<void> {
  try {
    await fs.promises.unlink(blobPath(storeDir, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
}

async function ensureStoreDir(storeDir: string): Promise<void> {
  await fs.promises.mkdir(storeDir, { recursive: true });
}

function resolveStoreDirLazy(opts?: PendingUploadFsStoreOptions): () => string {
  if (opts?.storeDir) {
    const dir = opts.storeDir;
    return () => dir;
  }
  // Defer msteams runtime / state-dir resolution until the first time the
  // store actually needs to touch disk. Resolving eagerly would throw in
  // tests (and other bootstrap paths) where the msteams runtime hasn't been
  // initialized yet, but where the caller only needs a store reference.
  let cached: string | null = null;
  return () => {
    if (cached !== null) {
      return cached;
    }
    const indexPath = resolveMSTeamsStorePath({
      filename: `${STORE_DIRNAME}/${INDEX_FILENAME}`,
      env: opts?.env,
      homedir: opts?.homedir,
      stateDir: opts?.stateDir,
    });
    cached = path.dirname(indexPath);
    return cached;
  };
}

export function createPendingUploadFsStore(
  opts?: PendingUploadFsStoreOptions,
): PendingUploadFsStore {
  const ttlMs = opts?.ttlMs ?? PENDING_UPLOAD_FS_TTL_MS;
  const getStoreDir = resolveStoreDirLazy(opts);
  const getIndexPath = () => path.join(getStoreDir(), INDEX_FILENAME);

  const readIndex = async (indexPath: string): Promise<PendingUploadFsIndex> => {
    const { value } = await readJsonFile(indexPath, EMPTY_INDEX);
    if (value.version !== 1 || !value.entries || typeof value.entries !== "object") {
      return EMPTY_INDEX;
    }
    return value;
  };

  const readAndPruneLocked = async (
    storeDir: string,
    indexPath: string,
  ): Promise<PendingUploadFsIndex> => {
    const current = await readIndex(indexPath);
    const nowMs = Date.now();
    const { index, expiredIds } = pruneExpired(current, nowMs, ttlMs);
    if (expiredIds.length > 0) {
      await writeJsonFile(indexPath, index);
      for (const id of expiredIds) {
        await unlinkBlobIfPresent(storeDir, id);
      }
    }
    return index;
  };

  const store: PendingUploadFsStore = {
    async store(params) {
      const storeDir = getStoreDir();
      const indexPath = getIndexPath();
      await ensureStoreDir(storeDir);
      const id = crypto.randomUUID();
      // Write the blob FIRST (best-effort crash safety: if we crash between
      // blob write and index update, a stale blob without an index entry is
      // just disk litter that the next prune cycle can skip).
      await fs.promises.writeFile(blobPath(storeDir, id), new Uint8Array(params.buffer));
      try {
        await withFileLock(indexPath, EMPTY_INDEX, async () => {
          const current = await readAndPruneLocked(storeDir, indexPath);
          const entry: PendingUploadFsEntry = {
            id,
            filename: params.filename,
            contentType: params.contentType,
            conversationId: params.conversationId,
            size: params.buffer.length,
            createdAt: Date.now(),
          };
          current.entries[id] = entry;
          await writeJsonFile(indexPath, current);
        });
      } catch (err) {
        await unlinkBlobIfPresent(storeDir, id).catch(() => {});
        throw err;
      }
      return id;
    },

    async get(id) {
      if (!id || !isSafeUploadId(id)) {
        return undefined;
      }
      const storeDir = getStoreDir();
      const indexPath = getIndexPath();
      return await withFileLock(indexPath, EMPTY_INDEX, async () => {
        const current = await readAndPruneLocked(storeDir, indexPath);
        const entry = current.entries[id];
        if (!entry) {
          return undefined;
        }
        let buffer: Buffer;
        try {
          buffer = await fs.promises.readFile(blobPath(storeDir, id));
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            // Orphan metadata (blob missing) — drop the index row so we never
            // return half-written state.
            delete current.entries[id];
            await writeJsonFile(indexPath, current);
            return undefined;
          }
          throw err;
        }
        return { entry, buffer };
      });
    },

    async remove(id) {
      if (!id || !isSafeUploadId(id)) {
        return;
      }
      const storeDir = getStoreDir();
      const indexPath = getIndexPath();
      await withFileLock(indexPath, EMPTY_INDEX, async () => {
        const current = await readIndex(indexPath);
        const hadEntry = Object.hasOwn(current.entries, id);
        if (hadEntry) {
          delete current.entries[id];
          await writeJsonFile(indexPath, current);
        }
      });
      await unlinkBlobIfPresent(storeDir, id);
    },

    async count() {
      const storeDir = getStoreDir();
      const indexPath = getIndexPath();
      return await withFileLock(indexPath, EMPTY_INDEX, async () => {
        const current = await readAndPruneLocked(storeDir, indexPath);
        return Object.keys(current.entries).length;
      });
    },
  };

  return store;
}

/**
 * Default, lazily-instantiated process-wide FS store.
 *
 * Callers that need a dedicated store (tests, alternate state dirs) should
 * build one via `createPendingUploadFsStore` directly.
 */
let defaultStore: PendingUploadFsStore | null = null;
export function getDefaultPendingUploadFsStore(): PendingUploadFsStore {
  if (!defaultStore) {
    defaultStore = createPendingUploadFsStore();
  }
  return defaultStore;
}

/** Test helper — resets the cached default store so later tests see a fresh dir. */
export function resetDefaultPendingUploadFsStoreForTests(): void {
  defaultStore = null;
}
