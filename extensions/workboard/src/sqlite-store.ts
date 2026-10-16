import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  resolveDatabaseEngineInput,
  openEngineWorkerStore,
  runEngineStoreOperation,
} from "openclaw/plugin-sdk/database-engine-runtime";
import { readSqliteDatabaseWriteTokenForPath } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { WorkboardPersistence, WorkboardWriteAuthority } from "./persistence-types.js";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { unwrapWorkboardSqliteResult } from "./sqlite-store-errors.js";

type WorkboardSqliteStores = WorkboardPersistence & {
  ready: Promise<void>;
  readWriteToken(this: void): string | undefined;
  close(this: void): Promise<void>;
  runWithWriteAuthority: WorkboardWriteAuthority;
};

export function createWorkboardSqliteStores(options: {
  config?: Parameters<typeof resolveDatabaseEngineInput>[0];
  dbPath?: string;
  workerModuleUrl: URL;
}): WorkboardSqliteStores {
  const databasePath = path.resolve(
    options.dbPath ?? path.join(resolveStateDir(), "plugins", "workboard", "workboard.sqlite"),
  );
  const selectedDatabase = resolveDatabaseEngineInput(options.config ?? {});
  const worker = selectedDatabase.then((input) =>
    openEngineWorkerStore<WorkboardSqliteWorkerOperations>(
      {
        moduleUrl: options.workerModuleUrl,
        databasePath,
        input,
      },
      input,
    ),
  );
  let sealed = false;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const writeAuthority = new AsyncLocalStorage<{ active: boolean; assertCurrent?: () => void }>();
  const ready = worker.then(() => undefined);
  void ready.catch(() => {});
  async function execute<K extends keyof WorkboardSqliteOperations>(
    type: K,
    input: WorkboardSqliteOperations[K]["input"],
    writes = false,
  ): Promise<WorkboardSqliteOperations[K]["output"]> {
    const authority = writes ? writeAuthority.getStore() : undefined;
    const store = await worker;
    const result = unwrapWorkboardSqliteResult(
      await runEngineStoreOperation(
        store,
        await selectedDatabase,
        writes,
        (scope) => scope.execute({ type, input }),
        authority
          ? () => {
              if (!authority.active) {
                throw new Error("Workboard mutation authority has settled.");
              }
              authority.assertCurrent?.();
            }
          : undefined,
        databasePath,
      ),
    );
    // A rejected comparison has accepted no mutation; a retry still needs authority.
    if (authority && result !== false && result !== "conflict" && result !== "owner_busy") {
      authority.assertCurrent = undefined;
    }
    return result;
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (sealed) {
      throw new Error("Workboard SQLite connection is closed.");
    }
    const pending = operation();
    operations.add(pending);
    try {
      return await pending;
    } finally {
      operations.delete(pending);
    }
  }
  function bindOperation<K extends keyof WorkboardSqliteOperations>(type: K, writes = false) {
    return (...args: WorkboardSqliteOperations[K]["input"]["args"]) =>
      run(() => execute(type, { args }, writes));
  }
  return {
    async runWithWriteAuthority(assertCurrent, operation) {
      const authority: { active: boolean; assertCurrent?: () => void } = {
        active: true,
        assertCurrent,
      };
      try {
        return await writeAuthority.run(authority, operation);
      } finally {
        authority.active = false;
      }
    },
    ready,
    readWriteToken: () => readSqliteDatabaseWriteTokenForPath(databasePath),
    cards: {
      register: bindOperation("cards.register", true),
      registerIfAbsent: bindOperation("cards.registerIfAbsent", true),
      registerIfUpdatedAt: bindOperation("cards.registerIfUpdatedAt", true),
      claimIfOwnerAvailable: bindOperation("cards.claimIfOwnerAvailable", true),
      deleteIfUpdatedAt: bindOperation("cards.deleteIfUpdatedAt", true),
      lookup: bindOperation("cards.lookup"),
      delete: bindOperation("cards.delete", true),
      entries: bindOperation("cards.entries"),
      listCardStatuses: bindOperation("cards.listCardStatuses"),
      listBoardAggregates: bindOperation("cards.listBoardAggregates"),
      listStatsAggregates: bindOperation("cards.listStatsAggregates"),
      hasCards: bindOperation("cards.hasCards"),
    },
    boards: {
      register: bindOperation("boards.register", true),
      lookup: bindOperation("boards.lookup"),
      delete: bindOperation("boards.delete", true),
      entries: bindOperation("boards.entries"),
    },
    sessionsBoard: {
      get: bindOperation("sessionsBoard.get"),
      update: bindOperation("sessionsBoard.update", true),
      listPlacements: bindOperation("sessionsBoard.listPlacements"),
      repairPlacements: bindOperation("sessionsBoard.repairPlacements", true),
      writePlacement: bindOperation("sessionsBoard.writePlacement", true),
    },
    subscriptions: {
      register: bindOperation("subscriptions.register", true),
      lookup: bindOperation("subscriptions.lookup"),
      delete: bindOperation("subscriptions.delete", true),
      entries: bindOperation("subscriptions.entries"),
    },
    attachments: {
      register: bindOperation("attachments.register", true),
      lookup: bindOperation("attachments.lookup"),
      delete: bindOperation("attachments.delete", true),
      entries: bindOperation("attachments.entries"),
    },
    close() {
      sealed = true;
      closing ??= Promise.resolve()
        .then(async () => {
          while (operations.size) {
            await Promise.allSettled(operations);
          }
          const store = await worker.catch(() => undefined);
          await store?.close();
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
      return closing;
    },
  };
}
