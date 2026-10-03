import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardSessionsBoardStore,
  WorkboardSubscriptionStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { unwrapWorkboardSqliteResult } from "./sqlite-store-errors.js";

type WorkboardSqliteStores = {
  cards: WorkboardCardStore;
  boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
  sessionsBoard: WorkboardSessionsBoardStore;
  subscriptions: WorkboardSubscriptionStore;
  attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  ready: Promise<number>;
  dataVersion(this: void): Promise<number>;
  close(this: void): Promise<void>;
  runWithWriteAuthority: WorkboardWriteAuthority;
};

export function createWorkboardSqliteStores(options: {
  dbPath?: string;
  workerModuleUrl: URL;
}): WorkboardSqliteStores {
  const databasePath = path.resolve(
    options.dbPath ?? path.join(resolveStateDir(), "plugins", "workboard", "workboard.sqlite"),
  );
  const worker = openSqliteWorkerStore<WorkboardSqliteWorkerOperations>({
    moduleUrl: options.workerModuleUrl,
    databasePath,
    input: undefined,
  });
  let ownedConnection: number | undefined;
  let brokerClosed = false;
  let brokerCleanup = false;
  let sealed = false;
  let openingFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const writeAuthority = new AsyncLocalStorage<{ active: boolean; assertCurrent?: () => void }>();
  async function cleanup() {
    // Rejected admission stays broker-owned; this facade received no lease to release.
    const store = await worker.catch(() => undefined);
    if (!store) {
      return;
    }
    if (ownedConnection !== undefined && !brokerCleanup) {
      const result = await store
        .execute({ type: "connection.close", input: { connection: ownedConnection } })
        .catch((error: unknown) => {
          const code = extractErrorCode(error);
          if (code === "closed" || code === "unavailable" || code === "outcome-unknown") {
            // Terminal transport cleanup belongs to the broker's joined retirement.
            brokerCleanup = true;
            return undefined;
          }
          throw error;
        });
      if (result !== undefined) {
        unwrapWorkboardSqliteResult(result);
        ownedConnection = undefined;
      }
    }
    if (!brokerClosed) {
      await store.close();
      brokerClosed = true;
      ownedConnection = undefined;
    }
  }
  const opened = worker
    .then(async (store) => {
      const result = await store.execute({ type: "connection.open", input: undefined });
      if (result.ok) {
        ownedConnection = result.value.connection;
        return result.value;
      }
      ownedConnection = result.failure.cleanupConnection;
      return unwrapWorkboardSqliteResult<WorkboardSqliteOperations["connection.open"]["output"]>(
        result,
      );
    })
    .catch(async (error: unknown) => {
      openingFailure = { error };
      sealed = true;
      if (ownedConnection === undefined) {
        try {
          await cleanup();
        } catch {
          /* Explicit close retains the failed broker cleanup. */
        }
      }
      throw error;
    });
  const ready = opened.then((value) => value.dataVersion);
  void ready.catch(() => {});
  async function execute<K extends keyof WorkboardSqliteOperations>(
    type: K,
    input: WorkboardSqliteOperations[K]["input"],
    writes = false,
  ): Promise<WorkboardSqliteOperations[K]["output"]> {
    const authority = writes ? writeAuthority.getStore() : undefined;
    const store = await worker;
    if (!authority) {
      return unwrapWorkboardSqliteResult(await store.execute({ type, input }));
    }
    const result = unwrapWorkboardSqliteResult(
      await runSqliteWorkerStoreOperation(
        store,
        (scope) => scope.execute({ type, input }),
        undefined,
        () => {
          if (!authority.active) {
            throw new Error("Workboard mutation authority has settled.");
          }
          authority.assertCurrent?.();
        },
      ),
    );
    // A rejected comparison has accepted no mutation; a retry still needs authority.
    if (result !== false && result !== "conflict" && result !== "owner_busy") {
      authority.assertCurrent = undefined;
    }
    return result;
  }
  async function run<Args, T>(
    args: Args,
    operation: (connection: number, captured: Args) => Promise<T>,
  ): Promise<T> {
    if (openingFailure) {
      throw openingFailure.error;
    }
    if (sealed) {
      throw new Error("Workboard SQLite connection is closed.");
    }
    const captured = structuredClone(args);
    const pending = opened.then(({ connection }) => operation(connection, captured));
    operations.add(pending);
    try {
      return await pending;
    } finally {
      operations.delete(pending);
    }
  }
  function bindOperation<Args extends unknown[], Result>(
    operation: (connection: number, args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) => run(args, operation);
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
    dataVersion: () => run(undefined, (connection) => execute("dataVersion", { connection })),
    cards: {
      register: bindOperation((connection, args) =>
        execute("cards.register", { connection, args }, true),
      ),
      registerIfAbsent: bindOperation((connection, args) =>
        execute("cards.registerIfAbsent", { connection, args }, true),
      ),
      registerIfUpdatedAt: bindOperation((connection, args) =>
        execute("cards.registerIfUpdatedAt", { connection, args }, true),
      ),
      claimIfOwnerAvailable: bindOperation((connection, args) =>
        execute("cards.claimIfOwnerAvailable", { connection, args }, true),
      ),
      deleteIfUpdatedAt: bindOperation((connection, args) =>
        execute("cards.deleteIfUpdatedAt", { connection, args }, true),
      ),
      lookup: bindOperation((connection, args) => execute("cards.lookup", { connection, args })),
      delete: bindOperation((connection, args) =>
        execute("cards.delete", { connection, args }, true),
      ),
      entries: bindOperation((connection, args) => execute("cards.entries", { connection, args })),
      listCardStatuses: bindOperation((connection, args) =>
        execute("cards.listCardStatuses", { connection, args }),
      ),
      listBoardAggregates: bindOperation((connection, args) =>
        execute("cards.listBoardAggregates", { connection, args }),
      ),
      listStatsAggregates: bindOperation((connection, args) =>
        execute("cards.listStatsAggregates", { connection, args }),
      ),
      hasCards: bindOperation((connection, args) =>
        execute("cards.hasCards", { connection, args }),
      ),
    },
    boards: {
      register: bindOperation((connection, args) =>
        execute("boards.register", { connection, args }, true),
      ),
      lookup: bindOperation((connection, args) => execute("boards.lookup", { connection, args })),
      delete: bindOperation((connection, args) =>
        execute("boards.delete", { connection, args }, true),
      ),
      entries: bindOperation((connection, args) => execute("boards.entries", { connection, args })),
    },
    sessionsBoard: {
      get: bindOperation((connection, args) => execute("sessionsBoard.get", { connection, args })),
      update: bindOperation((connection, args) =>
        execute("sessionsBoard.update", { connection, args }, true),
      ),
      listPlacements: bindOperation((connection, args) =>
        execute("sessionsBoard.listPlacements", { connection, args }),
      ),
      repairPlacements: bindOperation((connection, args) =>
        execute("sessionsBoard.repairPlacements", { connection, args }, true),
      ),
      writePlacement: bindOperation((connection, args) =>
        execute("sessionsBoard.writePlacement", { connection, args }, true),
      ),
    },
    subscriptions: {
      register: bindOperation((connection, args) =>
        execute("subscriptions.register", { connection, args }, true),
      ),
      lookup: bindOperation((connection, args) =>
        execute("subscriptions.lookup", { connection, args }),
      ),
      delete: bindOperation((connection, args) =>
        execute("subscriptions.delete", { connection, args }, true),
      ),
      entries: bindOperation((connection, args) =>
        execute("subscriptions.entries", { connection, args }),
      ),
    },
    attachments: {
      register: bindOperation((connection, args) =>
        execute("attachments.register", { connection, args }, true),
      ),
      lookup: bindOperation((connection, args) =>
        execute("attachments.lookup", { connection, args }),
      ),
      delete: bindOperation((connection, args) =>
        execute("attachments.delete", { connection, args }, true),
      ),
      entries: bindOperation((connection, args) =>
        execute("attachments.entries", { connection, args }),
      ),
    },
    close() {
      sealed = true;
      closing ??= Promise.resolve()
        .then(async () => {
          while (operations.size) {
            await Promise.allSettled(operations);
          }
          await opened.catch(() => undefined);
          await cleanup();
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
      return closing;
    },
  };
}
