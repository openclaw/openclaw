import {
  runEngineWorkerWrite,
  type DatabaseEngineInput,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  requestSqliteWorkerOperationAdmission,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { encodeWorkboardSqliteFailure } from "./sqlite-store-errors.js";
import { createWorkboardSqliteKernel } from "./sqlite-store-kernel.js";

export function createSqliteWorkerBackend(
  input: DatabaseEngineInput,
  context: { databasePath: string },
): SqliteWorkerBackend<WorkboardSqliteWorkerOperations> {
  const kernel = createWorkboardSqliteKernel(context.databasePath, undefined, input);
  const operations: {
    [K in keyof WorkboardSqliteOperations]: (
      ...args: WorkboardSqliteOperations[K]["input"]["args"]
    ) => WorkboardSqliteOperations[K]["output"];
  } = {
    "cards.register": kernel.cards.register.bind(kernel.cards),
    "cards.registerIfAbsent": kernel.cards.registerIfAbsent.bind(kernel.cards),
    "cards.registerIfUpdatedAt": kernel.cards.registerIfUpdatedAt.bind(kernel.cards),
    "cards.claimIfOwnerAvailable": kernel.cards.claimIfOwnerAvailable.bind(kernel.cards),
    "cards.deleteIfUpdatedAt": kernel.cards.deleteIfUpdatedAt.bind(kernel.cards),
    "cards.lookup": kernel.cards.lookup.bind(kernel.cards),
    "cards.delete": kernel.cards.delete.bind(kernel.cards),
    "cards.entries": kernel.cards.entries.bind(kernel.cards),
    "cards.listCardStatuses": kernel.cards.listCardStatuses.bind(kernel.cards),
    "cards.listBoardAggregates": kernel.cards.listBoardAggregates.bind(kernel.cards),
    "cards.listStatsAggregates": kernel.cards.listStatsAggregates.bind(kernel.cards),
    "cards.hasCards": kernel.cards.hasCards.bind(kernel.cards),
    "boards.register": kernel.boards.register.bind(kernel.boards),
    "boards.lookup": kernel.boards.lookup.bind(kernel.boards),
    "boards.delete": kernel.boards.delete.bind(kernel.boards),
    "boards.entries": kernel.boards.entries.bind(kernel.boards),
    "sessionsBoard.get": kernel.sessionsBoard.get.bind(kernel.sessionsBoard),
    "sessionsBoard.update": kernel.sessionsBoard.update.bind(kernel.sessionsBoard),
    "sessionsBoard.listPlacements": kernel.sessionsBoard.listPlacements.bind(kernel.sessionsBoard),
    "sessionsBoard.repairPlacements": kernel.sessionsBoard.repairPlacements.bind(
      kernel.sessionsBoard,
    ),
    "sessionsBoard.writePlacement": kernel.sessionsBoard.writePlacement.bind(kernel.sessionsBoard),
    "subscriptions.register": kernel.subscriptions.register.bind(kernel.subscriptions),
    "subscriptions.lookup": kernel.subscriptions.lookup.bind(kernel.subscriptions),
    "subscriptions.delete": kernel.subscriptions.delete.bind(kernel.subscriptions),
    "subscriptions.entries": kernel.subscriptions.entries.bind(kernel.subscriptions),
    "attachments.register": kernel.attachments.register.bind(kernel.attachments),
    "attachments.lookup": kernel.attachments.lookup.bind(kernel.attachments),
    "attachments.delete": kernel.attachments.delete.bind(kernel.attachments),
    "attachments.entries": kernel.attachments.entries.bind(kernel.attachments),
  };
  function execute<K extends keyof WorkboardSqliteOperations>(
    command: SqliteWorkerCommand<Pick<WorkboardSqliteOperations, K>>,
  ): WorkboardSqliteOperations[K]["output"] {
    return operations[command.type](...command.input.args);
  }
  return {
    execute(command) {
      try {
        const readOnly = [
          "cards.lookup",
          "cards.entries",
          "cards.listCardStatuses",
          "cards.listBoardAggregates",
          "cards.listStatsAggregates",
          "cards.hasCards",
          "boards.lookup",
          "boards.entries",
          "sessionsBoard.get",
          "sessionsBoard.listPlacements",
          "subscriptions.lookup",
          "subscriptions.entries",
          "attachments.lookup",
          "attachments.entries",
        ].includes(command.type);
        const value = !readOnly
          ? runEngineWorkerWrite(
              input,
              () => execute(command),
              (operation) => {
                requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
                return kernel.withWriteTransaction(operation, {
                  withCommit(commit) {
                    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
                    commit();
                  },
                });
              },
            )
          : execute(command);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, failure: encodeWorkboardSqliteFailure(error) };
      }
    },
    close: kernel.close,
  };
}
