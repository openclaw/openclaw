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
  function execute(
    command: SqliteWorkerCommand<WorkboardSqliteOperations>,
  ): WorkboardSqliteOperations[keyof WorkboardSqliteOperations]["output"] {
    switch (command.type) {
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
      case "sessionsBoard.get":
        return kernel.sessionsBoard.get(...command.input.args);
      case "sessionsBoard.update":
        return kernel.sessionsBoard.update(...command.input.args);
      case "sessionsBoard.listPlacements":
        return kernel.sessionsBoard.listPlacements(...command.input.args);
      case "sessionsBoard.repairPlacements":
        return kernel.sessionsBoard.repairPlacements(...command.input.args);
      case "sessionsBoard.writePlacement":
        return kernel.sessionsBoard.writePlacement(...command.input.args);
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
