import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const MATRIX_SYNC_STORE_FILENAME = "bot-storage.json";
const MATRIX_PLUGIN_ID = "matrix";
const MATRIX_INBOUND_DEDUPE_NAMESPACE = "inbound-dedupe";
const MATRIX_STORAGE_META_NAMESPACE = "storage-meta";
const MATRIX_SYNC_STORE_NAMESPACE = "sync-store";
const MATRIX_STATE_POLL_INTERVAL_MS = 100;

type MatrixInboundDedupeEntry = {
  roomId: string;
  eventId: string;
  ts: number;
};

type MatrixStorageMetaEntry = {
  accountId?: string;
  rootDir?: string;
  userId?: string;
};

type PersistedMatrixSyncStore = {
  version?: number;
  savedSync?: {
    nextBatch?: string;
  } | null;
  cleanShutdown?: boolean;
  clientOptions?: unknown;
};

const matrixInboundDedupeStore = createPluginStateKeyedStore<MatrixInboundDedupeEntry>(
  MATRIX_PLUGIN_ID,
  {
    namespace: MATRIX_INBOUND_DEDUPE_NAMESPACE,
    maxEntries: 20_000,
  },
);

const matrixStorageMetaStore = createPluginStateKeyedStore<MatrixStorageMetaEntry>(
  MATRIX_PLUGIN_ID,
  {
    namespace: MATRIX_STORAGE_META_NAMESPACE,
    maxEntries: 10_000,
  },
);

const matrixSyncStore = createPluginStateKeyedStore<PersistedMatrixSyncStore>(MATRIX_PLUGIN_ID, {
  namespace: MATRIX_SYNC_STORE_NAMESPACE,
  maxEntries: 1000,
});

function withOpenClawStateDir<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return fn().finally(() => {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  });
}

function resolveMatrixSyncStoreKey(storagePath: string): string {
  return createHash("sha256").update(path.resolve(storagePath), "utf8").digest("hex").slice(0, 32);
}

function inferStateDirFromMatrixStoragePath(storagePath: string): string | null {
  const parts = path.resolve(storagePath).split(path.sep);
  const matrixIndex = parts.lastIndexOf("matrix");
  if (matrixIndex <= 0) {
    return null;
  }
  return parts.slice(0, matrixIndex).join(path.sep) || path.sep;
}

function readPersistedMatrixSyncCursor(
  persisted: PersistedMatrixSyncStore | undefined,
): string | null {
  const nextBatch = persisted?.savedSync?.nextBatch;
  return typeof nextBatch === "string" && nextBatch.trim() ? nextBatch : null;
}

export async function rewriteMatrixSyncStoreCursor(params: { cursor: string; pathname: string }) {
  const rewrite = async () => {
    const key = resolveMatrixSyncStoreKey(params.pathname);
    const persisted = await matrixSyncStore.lookup(key);
    if (!persisted?.savedSync) {
      throw new Error("Matrix sync store did not contain a persisted sync cursor");
    }
    await matrixSyncStore.register(key, {
      ...persisted,
      savedSync: {
        ...persisted.savedSync,
        nextBatch: params.cursor,
      },
    });
  };
  const stateDir = inferStateDirFromMatrixStoragePath(params.pathname);
  if (stateDir) {
    await withOpenClawStateDir(stateDir, rewrite);
    return;
  }
  await rewrite();
}

async function scoreMatrixStateFile(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  metadata: MatrixStorageMetaEntry;
  userId?: string;
}) {
  let score = 4;
  const expectedUserId = params.userId ?? params.context.sutUserId;
  const expectedAccountId = params.accountId ?? params.context.sutAccountId;
  if (params.metadata.userId === expectedUserId) {
    score += 16;
  }
  if (params.metadata.accountId === expectedAccountId) {
    score += 8;
  }
  return score;
}

async function resolveBestMatrixStateFile(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  filename: string;
  stateDir: string;
  userId?: string;
}) {
  const stateRoot = path.resolve(params.stateDir);
  const metadataEntries = await matrixStorageMetaStore.entries();
  const candidates = metadataEntries.flatMap((entry) => {
    const rootDir = entry.value.rootDir;
    if (!rootDir) {
      return [];
    }
    const resolvedRoot = path.resolve(rootDir);
    if (!resolvedRoot.startsWith(stateRoot)) {
      return [];
    }
    const pathname = path.join(resolvedRoot, params.filename);
    return [{ metadata: entry.value, pathname }];
  });
  if (candidates.length === 0) {
    return null;
  }
  const scored = await Promise.all(
    candidates.map(async (candidate) => ({
      pathname: candidate.pathname,
      persisted: await matrixSyncStore.lookup(resolveMatrixSyncStoreKey(candidate.pathname)),
      score: await scoreMatrixStateFile({
        context: params.context,
        metadata: candidate.metadata,
        ...(params.accountId ? { accountId: params.accountId } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
      }),
    })),
  );
  const withCursor = scored.filter((entry) => readPersistedMatrixSyncCursor(entry.persisted));
  withCursor.sort((a, b) => b.score - a.score || a.pathname.localeCompare(b.pathname));
  return withCursor[0] ?? null;
}

export async function waitForMatrixSyncStoreWithCursor(params: {
  accountId?: string;
  context: MatrixQaScenarioContext;
  stateDir: string;
  timeoutMs: number;
  userId?: string;
}) {
  const startedAt = Date.now();
  let lastPath: string | null = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    const candidate = await withOpenClawStateDir(params.stateDir, () =>
      resolveBestMatrixStateFile({
        context: params.context,
        filename: MATRIX_SYNC_STORE_FILENAME,
        stateDir: params.stateDir,
        ...(params.accountId ? { accountId: params.accountId } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
      }),
    );
    lastPath = candidate?.pathname ?? null;
    const cursor = readPersistedMatrixSyncCursor(candidate?.persisted);
    if (candidate && cursor) {
      return { cursor, pathname: candidate.pathname };
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix sync store cursor under ${params.stateDir}; last path ${lastPath ?? "<none>"}`,
  );
}

function buildMatrixInboundDedupeKey(params: {
  accountId: string;
  roomId: string;
  eventId: string;
}): string {
  const accountId = params.accountId.trim() || "default";
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(params.roomId.trim())
    .update("\0")
    .update(params.eventId.trim())
    .digest("hex");
  return `${accountId}:${digest}`;
}

async function hasPersistedMatrixDedupeEntry(params: {
  accountId?: string;
  eventId: string;
  roomId: string;
  stateDir: string;
}) {
  return withOpenClawStateDir(params.stateDir, async () => {
    const entry = await matrixInboundDedupeStore.lookup(
      buildMatrixInboundDedupeKey({
        accountId: params.accountId ?? "default",
        roomId: params.roomId,
        eventId: params.eventId,
      }),
    );
    return entry?.roomId === params.roomId && entry.eventId === params.eventId;
  });
}

export async function waitForMatrixInboundDedupeEntry(params: {
  context: MatrixQaScenarioContext;
  eventId: string;
  roomId: string;
  stateDir: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (
      await hasPersistedMatrixDedupeEntry({
        accountId: params.context.sutAccountId,
        roomId: params.roomId,
        eventId: params.eventId,
        stateDir: params.stateDir,
      })
    ) {
      return "plugin_state_entries:matrix/inbound-dedupe";
    }
    await sleep(MATRIX_STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Matrix inbound dedupe commit for ${params.roomId}|${params.eventId}`,
  );
}
