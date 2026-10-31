import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { MessagePort } from "node:worker_threads";
import {
  hasSqliteWorkerOutcomeUnknown,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { encodeWorkboardSqliteFailure } from "../sqlite-store-errors.js";
import { createWorkboardSqliteKernel } from "../sqlite-store-kernel.js";
import { createWorkboardDatabase } from "../sqlite-store-schema.js";
import type {
  PostgresFixtureInput,
  PostgresFixtureOperations,
  PostgresFixtureReply,
  PostgresFixtureRequest,
} from "./postgres-fixture-contract.js";

export function createSqliteWorkerBackend(
  input: PostgresFixtureInput,
): SqliteWorkerBackend<PostgresFixtureOperations> {
  const owner = createWorkboardDatabase(input.dbPath, undefined, input.postgresInput);
  const db = owner.db;
  if (db instanceof DatabaseSync) {
    owner.close();
    throw new Error("PostgreSQL fixture did not select PostgreSQL");
  }
  function executeOperation(operation: PostgresFixtureRequest["operation"]): unknown {
    switch (operation.kind) {
      case "groupedRollback": {
        const kernel = createWorkboardSqliteKernel(input.dbPath, undefined, input.postgresInput);
        const { sibling, target, fault } = operation;
        const { id, updatedAt } = target;
        try {
          kernel.cards.register(sibling.id, { version: 1, card: sibling });
          kernel.cards.register(id, { version: 1, card: target });
          const invalidComment = { ...sibling.metadata!.comments![0]! };
          if (fault === "binding") {
            Object.defineProperty(invalidComment, "body", { value: { invalid: true } });
          }
          const comments = Array.from({ length: 65 }, (_, i) => ({
            id: `replacement-${i}`,
            body: "Row",
            createdAt: 1000,
          }));
          comments.push(invalidComment);
          const next = {
            ...target,
            title: "Claimed",
            updatedAt: updatedAt + 1,
            labels: ["changed"],
            metadata: { ...target.metadata, comments },
          };
          let failure;
          try {
            kernel.withWriteTransaction(() => {
              const board = { id: "grouped", createdAt: 1, updatedAt: 2 };
              kernel.boards.register(board.id, { version: 1, board });
              const replacement = { version: 1, card: next };
              kernel.cards.claimIfOwnerAvailable(id, replacement, updatedAt, "slot-owner", 3000);
            });
          } catch (error) {
            failure = encodeWorkboardSqliteFailure(error);
          }
          return {
            failure,
            board: kernel.boards.lookup("grouped"),
            target: kernel.cards.lookup(id),
            sibling: kernel.cards.lookup(sibling.id),
          };
        } finally {
          kernel.close();
        }
      }
      case "state":
        return { schema: db.schema, isOpen: db.isOpen, isTransaction: db.isTransaction };
      case "statements": {
        const execute = () => {
          const values = operation.statements.map(({ sql, args, method, catchError }) => {
            try {
              return method ? db.prepare(sql)[method](...(args ?? [])) : db.exec(sql);
            } catch (error) {
              if (!catchError) {
                throw error;
              }
              return undefined;
            }
          });
          if (operation.reject) {
            throw new Error(operation.reject);
          }
          return values;
        };
        return operation.transaction ? runSqliteImmediateTransactionSync(db, execute) : execute();
      }
      case "assertClosed": {
        const postMessage = mock.method(MessagePort.prototype, "postMessage");
        let failure: unknown;
        try {
          db.exec(operation.sql);
        } catch (error) {
          failure = error;
        } finally {
          postMessage.mock.restore();
        }
        const sent = postMessage.mock.callCount() > 0;
        return { sent, failure: failure instanceof Error ? failure.message : undefined };
      }
    }
    return undefined;
  }
  return {
    execute({ input: operation }): PostgresFixtureReply {
      try {
        return { result: { ok: true, value: executeOperation(operation) } };
      } catch (error) {
        return {
          result: { ok: false, failure: encodeWorkboardSqliteFailure(error) },
          outcomeUnknown: hasSqliteWorkerOutcomeUnknown(error),
        };
      }
    },
    close: owner.close,
  };
}
