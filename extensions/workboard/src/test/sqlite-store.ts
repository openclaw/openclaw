import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach } from "vitest";
import type {
  PersistedWorkboardCard,
  WorkboardCardStore,
  WorkboardWriteAuthority,
} from "../persistence-types.js";
import { workboardSqliteBackendEntrypoint } from "../sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "../sqlite-store.js";
import { WorkboardStore } from "../store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

type WorkboardSqliteTestStores = Omit<
  ReturnType<typeof createWorkboardSqliteStores>,
  "runWithWriteAuthority"
> & { runWithWriteAuthority?: WorkboardWriteAuthority };

type WorkboardSqliteTestOptions = {
  createStores?: (dbPath: string) => WorkboardSqliteTestStores;
  beforeCardWrite?: (key: string, value: PersistedWorkboardCard) => void | Promise<void>;
  beforeCardLookup?: (key: string) => void | Promise<void>;
  onStoreClose?: () => void | Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Workboard SQLite test cleanup failed");
  }
});

function withCardHooks(
  cards: WorkboardCardStore,
  options: WorkboardSqliteTestOptions,
): WorkboardCardStore {
  return {
    async register(key, value) {
      await options.beforeCardWrite?.(key, value);
      await cards.register(key, value);
    },
    async registerIfAbsent(key, value) {
      await options.beforeCardWrite?.(key, value);
      return cards.registerIfAbsent(key, value);
    },
    async registerIfUpdatedAt(key, value, expectedUpdatedAt) {
      await options.beforeCardWrite?.(key, value);
      return cards.registerIfUpdatedAt(key, value, expectedUpdatedAt);
    },
    async claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now) {
      await options.beforeCardWrite?.(key, value);
      return cards.claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now);
    },
    async lookup(key) {
      await options.beforeCardLookup?.(key);
      return cards.lookup(key);
    },
    delete: (key) => cards.delete(key),
    deleteIfUpdatedAt: (key, expectedUpdatedAt) => cards.deleteIfUpdatedAt(key, expectedUpdatedAt),
    entries: (scope) => cards.entries(scope),
    listCardStatuses: (ids) => cards.listCardStatuses(ids),
    listBoardAggregates: () => cards.listBoardAggregates(),
    listStatsAggregates: (boardId) => cards.listStatsAggregates(boardId),
    hasCards: (boardId) => cards.hasCards(boardId),
  };
}

export function createWorkboardSqliteTestHarness(options: WorkboardSqliteTestOptions = {}) {
  // openclaw-temp-dir: allow closes the SQLite owner before removing database files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-test-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  let sqlite: WorkboardSqliteTestStores;
  try {
    sqlite = options.createStores
      ? options.createStores(dbPath)
      : createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const closeDatabase = () => sqlite.close();
  const stores = {
    ...sqlite,
    cards:
      options.beforeCardWrite || options.beforeCardLookup
        ? withCardHooks(sqlite.cards, options)
        : sqlite.cards,
    close: closeDatabase,
  };
  let storeCloseObserved = false;
  const store = new WorkboardStore(stores.cards, {
    ...stores,
    close: async () => {
      storeCloseObserved = true;
      await (options.onStoreClose ?? closeDatabase)();
    },
  });
  cleanups.push(async () => {
    try {
      if (!storeCloseObserved) {
        await store.close();
      }
    } finally {
      try {
        await closeDatabase();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  return { store, stores, dbPath };
}

export function createWorkboardSqliteTestStore(options: WorkboardSqliteTestOptions = {}) {
  return createWorkboardSqliteTestHarness(options).store;
}

export function sqliteTestAuxStores(stores: WorkboardSqliteTestStores) {
  const { boards, subscriptions, attachments, ready } = stores;
  return { boards, subscriptions, attachments, ready };
}
