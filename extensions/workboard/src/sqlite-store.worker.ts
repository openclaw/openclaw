import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { encodeWorkboardSqliteFailure } from "./sqlite-store-errors.js";
import { createWorkboardSqliteKernel, type WorkboardSqliteKernel } from "./sqlite-store-kernel.js";
type Connection = { kernel?: WorkboardSqliteKernel; close: () => void };
type ConnectionCommand = Exclude<
  SqliteWorkerCommand<WorkboardSqliteOperations>,
  { type: "connection.open" }
>;

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<WorkboardSqliteWorkerOperations> {
  const initial = createWorkboardSqliteKernel(context.databasePath);
  const connections = new Map<number, Connection>();
  // Broker admission opens the native database; the first logical lease adopts it.
  connections.set(0, { kernel: initial, close: initial.close });
  let nextConnection = 0;
  function execute(
    command: ConnectionCommand,
  ): WorkboardSqliteOperations[keyof WorkboardSqliteOperations]["output"] {
    const connection = connections.get(command.input.connection);
    if (!connection) {
      throw new Error("Workboard SQLite connection is closed.");
    }
    if (command.type === "connection.close") {
      connection.close();
      connections.delete(command.input.connection);
      return;
    }
    const kernel = connection.kernel;
    if (!kernel) {
      throw new Error("Workboard SQLite connection initialization failed.");
    }
    switch (command.type) {
      case "dataVersion":
        return kernel.dataVersion();
      case "cards.register":
        return kernel.cards.register(...command.input.args);
      case "cards.registerIfAbsent":
        return kernel.cards.registerIfAbsent(...command.input.args);
      case "cards.registerIfUpdatedAt":
        return kernel.cards.registerIfUpdatedAt(...command.input.args);
      case "cards.claimIfOwnerAvailable":
        return kernel.cards.claimIfOwnerAvailable(...command.input.args);
      case "cards.deleteIfUpdatedAt":
        return kernel.cards.deleteIfUpdatedAt(...command.input.args);
      case "cards.lookup":
        return kernel.cards.lookup(...command.input.args);
      case "cards.delete":
        return kernel.cards.delete(...command.input.args);
      case "cards.entries":
        return kernel.cards.entries(...command.input.args);
      case "cards.listCardStatuses":
        return kernel.cards.listCardStatuses(...command.input.args);
      case "cards.listBoardAggregates":
        return kernel.cards.listBoardAggregates(...command.input.args);
      case "cards.listStatsAggregates":
        return kernel.cards.listStatsAggregates(...command.input.args);
      case "cards.hasCards":
        return kernel.cards.hasCards(...command.input.args);
      case "boards.register":
        return kernel.boards.register(...command.input.args);
      case "boards.lookup":
        return kernel.boards.lookup(...command.input.args);
      case "boards.delete":
        return kernel.boards.delete(...command.input.args);
      case "boards.entries":
        return kernel.boards.entries(...command.input.args);
      case "subscriptions.register":
        return kernel.subscriptions.register(...command.input.args);
      case "subscriptions.lookup":
        return kernel.subscriptions.lookup(...command.input.args);
      case "subscriptions.delete":
        return kernel.subscriptions.delete(...command.input.args);
      case "subscriptions.entries":
        return kernel.subscriptions.entries(...command.input.args);
      case "attachments.register":
        return kernel.attachments.register(...command.input.args);
      case "attachments.lookup":
        return kernel.attachments.lookup(...command.input.args);
      case "attachments.delete":
        return kernel.attachments.delete(...command.input.args);
      case "attachments.entries":
        return kernel.attachments.entries(...command.input.args);
    }
  }
  return {
    execute(command) {
      if (command.type === "connection.open") {
        const connection = ++nextConnection;
        try {
          const unclaimed = connections.get(0);
          connections.delete(0);
          const kernel =
            unclaimed?.kernel ??
            createWorkboardSqliteKernel(context.databasePath, (close) => {
              connections.set(connection, { close });
            });
          connections.set(connection, { kernel, close: kernel.close });
          return { ok: true, value: { connection, dataVersion: kernel.dataVersion() } };
        } catch (error) {
          const owned = connections.get(connection);
          if (owned) {
            try {
              owned.close();
              connections.delete(connection);
            } catch {
              return {
                ok: false,
                failure: { ...encodeWorkboardSqliteFailure(error), cleanupConnection: connection },
              };
            }
          }
          return { ok: false, failure: encodeWorkboardSqliteFailure(error) };
        }
      }
      try {
        return { ok: true, value: execute(command) };
      } catch (error) {
        return { ok: false, failure: encodeWorkboardSqliteFailure(error) };
      }
    },
    close() {
      const failures: unknown[] = [];
      for (const [id, kernel] of connections) {
        try {
          kernel.close();
          connections.delete(id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Workboard SQLite cleanup failed");
      }
    },
  };
}
