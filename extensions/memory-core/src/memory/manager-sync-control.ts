import type { DatabaseSync } from "node:sqlite";
import {
  createSubsystemLogger,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySyncProgressUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const log = createSubsystemLogger("memory");

export type MemoryReadonlyRecoveryState = {
  closed: boolean;
  db: DatabaseSync;
  vectorReady: Promise<boolean> | null;
  vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  readonlyRecoveryAttempts: number;
  readonlyRecoverySuccesses: number;
  readonlyRecoveryFailures: number;
  readonlyRecoveryLastError?: string;
  runSync: (params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) => Promise<void>;
  openDatabase: () => DatabaseSync;
  ensureSchema: () => void;
  readMeta: () => { vectorDims?: number } | undefined;
};

export function isMemoryReadonlyDbError(err: unknown): boolean {
  const readonlyPattern =
    /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
  const messages = new Set<string>();

  const pushValue = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    messages.add(normalized);
  };

  pushValue(err instanceof Error ? err.message : String(err));
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    pushValue(record.message);
    pushValue(record.code);
    pushValue(record.name);
    if (record.cause && typeof record.cause === "object") {
      const cause = record.cause as Record<string, unknown>;
      pushValue(cause.message);
      pushValue(cause.code);
      pushValue(cause.name);
    }
  }

  return [...messages].some((value) => readonlyPattern.test(value));
}

export function extractMemoryErrorReason(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    if (typeof record.code === "string" && record.code.trim()) {
      return record.code;
    }
  }
  return String(err);
}

export async function runMemorySyncWithReadonlyRecovery(
  state: MemoryReadonlyRecoveryState,
  params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  },
): Promise<void> {
  try {
    await state.runSync(params);
    return;
  } catch (err) {
    if (!isMemoryReadonlyDbError(err) || state.closed) {
      throw err;
    }
    const reason = extractMemoryErrorReason(err);
    state.readonlyRecoveryAttempts += 1;
    state.readonlyRecoveryLastError = reason;
    log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
    try {
      state.db.close();
    } catch {}
    state.db = state.openDatabase();
    state.vectorReady = null;
    state.vector.available = null;
    state.vector.loadError = undefined;
    state.ensureSchema();
    const meta = state.readMeta();
    state.vector.dims = meta?.vectorDims;
    try {
      await state.runSync(params);
      state.readonlyRecoverySuccesses += 1;
    } catch (retryErr) {
      state.readonlyRecoveryFailures += 1;
      throw retryErr;
    }
  }
}

export function enqueueMemoryTargetedSessionSync(
  state: {
    closed: boolean;
    syncing: Promise<void> | null;
    queuedSessionFiles: Set<string>;
    queuedSessionSync: Promise<void> | null;
    sync: (params?: {
      reason?: string;
      force?: boolean;
      sessionFiles?: string[];
      progress?: (update: MemorySyncProgressUpdate) => void;
    }) => Promise<void>;
  },
  sessionFiles?: string[],
): Promise<void> {
  for (const sessionFile of sessionFiles ?? []) {
    const trimmed = sessionFile.trim();
    if (trimmed) {
      state.queuedSessionFiles.add(trimmed);
    }
  }
  if (state.queuedSessionFiles.size === 0) {
    return state.syncing ?? Promise.resolve();
  }
  if (!state.queuedSessionSync) {
    state.queuedSessionSync = (async () => {
      try {
        await state.syncing?.catch(() => undefined);
        while (!state.closed && state.queuedSessionFiles.size > 0) {
          const queuedSessionFiles = Array.from(state.queuedSessionFiles);
          state.queuedSessionFiles.clear();
          await state.sync({
            reason: "queued-session-files",
            sessionFiles: queuedSessionFiles,
          });
        }
      } finally {
        state.queuedSessionSync = null;
      }
    })();
  }
  return state.queuedSessionSync;
}

export function _createMemorySyncControlConfigForTests(
  workspaceDir: string,
  indexPath: string,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: false } },
          cache: { enabled: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}
