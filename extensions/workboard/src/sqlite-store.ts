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
  async function run<Args, T>(args: Args, operation: (captured: Args) => Promise<T>): Promise<T> {
    if (sealed) {
      throw new Error("Workboard SQLite connection is closed.");
    }
    const captured = structuredClone(args);
    const pending = operation(captured);
    operations.add(pending);
    try {
      return await pending;
    } finally {
      operations.delete(pending);
    }
  }
  function bindOperation<Args extends unknown[], Result>(
    operation: (input: { args: Args }) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) => run(args, (captured) => operation({ args: captured }));
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
      register: bindOperation((input) => execute("cards.register", input, true)),
      registerIfAbsent: bindOperation((input) => execute("cards.registerIfAbsent", input, true)),
      registerIfUpdatedAt: bindOperation((input) =>
        execute("cards.registerIfUpdatedAt", input, true),
      ),
      claimIfOwnerAvailable: bindOperation((input) =>
        execute("cards.claimIfOwnerAvailable", input, true),
      ),
      deleteIfUpdatedAt: bindOperation((input) => execute("cards.deleteIfUpdatedAt", input, true)),
      lookup: bindOperation((input) => execute("cards.lookup", input)),
      delete: bindOperation((input) => execute("cards.delete", input, true)),
      entries: bindOperation((input) => execute("cards.entries", input)),
      listCardStatuses: bindOperation((input) => execute("cards.listCardStatuses", input)),
      listBoardAggregates: bindOperation((input) => execute("cards.listBoardAggregates", input)),
      listStatsAggregates: bindOperation((input) => execute("cards.listStatsAggregates", input)),
      hasCards: bindOperation((input) => execute("cards.hasCards", input)),
    },
    boards: {
      register: bindOperation((input) => execute("boards.register", input, true)),
      lookup: bindOperation((input) => execute("boards.lookup", input)),
      delete: bindOperation((input) => execute("boards.delete", input, true)),
      entries: bindOperation((input) => execute("boards.entries", input)),
    },
    sessionsBoard: {
      get: bindOperation((input) => execute("sessionsBoard.get", input)),
      update: bindOperation((input) => execute("sessionsBoard.update", input, true)),
      listPlacements: bindOperation((input) => execute("sessionsBoard.listPlacements", input)),
      repairPlacements: bindOperation((input) =>
        execute("sessionsBoard.repairPlacements", input, true),
      ),
      writePlacement: bindOperation((input) =>
        execute("sessionsBoard.writePlacement", input, true),
      ),
    },
    subscriptions: {
      register: bindOperation((input) => execute("subscriptions.register", input, true)),
      lookup: bindOperation((input) => execute("subscriptions.lookup", input)),
      delete: bindOperation((input) => execute("subscriptions.delete", input, true)),
      entries: bindOperation((input) => execute("subscriptions.entries", input)),
    },
    attachments: {
      register: bindOperation((input) => execute("attachments.register", input, true)),
      lookup: bindOperation((input) => execute("attachments.lookup", input)),
      delete: bindOperation((input) => execute("attachments.delete", input, true)),
      entries: bindOperation((input) => execute("attachments.entries", input)),
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
