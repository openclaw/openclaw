import { DatabaseSync } from "node:sqlite";
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
  return {
    execute({ input: operation }) {
      let reply: PostgresFixtureReply;
      try {
        let value: unknown;
        switch (operation.kind) {
          case "groupedRollback": {
            const kernel = createWorkboardSqliteKernel(
              input.dbPath,
              undefined,
              input.postgresInput,
            );
            const { sibling, target, fault } = operation;
            try {
              kernel.cards.register(sibling.id, { version: 1, card: sibling });
              kernel.cards.register(target.id, { version: 1, card: target });
              const invalidComment = { ...sibling.metadata!.comments![0]! };
              if (fault === "binding") {
                Object.defineProperty(invalidComment, "body", {
                  value: { invalid: "native binding" },
                });
              }
              const next = {
                ...target,
                title: "Claimed",
                updatedAt: target.updatedAt + 1,
                labels: ["changed"],
                metadata: {
                  ...target.metadata,
                  comments: [
                    { id: "replacement-comment", body: "First row", createdAt: 1000 },
                    invalidComment,
                  ],
                },
              };
              let failure;
              try {
                kernel.withWriteTransaction(() => {
                  kernel.boards.register("grouped", {
                    version: 1,
                    board: { id: "grouped", createdAt: 1, updatedAt: 2 },
                  });
                  kernel.cards.claimIfOwnerAvailable(
                    target.id,
                    { version: 1, card: next },
                    target.updatedAt,
                    "slot-owner",
                    3000,
                  );
                });
              } catch (error) {
                failure = encodeWorkboardSqliteFailure(error);
              }
              value = {
                failure,
                board: kernel.boards.lookup("grouped"),
                target: kernel.cards.lookup(target.id),
                sibling: kernel.cards.lookup(sibling.id),
              };
            } finally {
              kernel.close();
            }
            break;
          }
          case "state":
            value = { schema: db.schema, isOpen: db.isOpen, isTransaction: db.isTransaction };
            break;
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
            value = operation.transaction
              ? runSqliteImmediateTransactionSync(db, execute)
              : execute();
            break;
          }
          case "assertClosed": {
            // oxlint-disable-next-line typescript/unbound-method -- Replay with the intercepted receiver below.
            const original = MessagePort.prototype.postMessage;
            let sent = false;
            MessagePort.prototype.postMessage = function (...args) {
              sent = true;
              return Reflect.apply(original, this, args);
            };
            let failure: unknown;
            try {
              db.exec(operation.sql);
            } catch (error) {
              failure = error;
            } finally {
              MessagePort.prototype.postMessage = original;
            }
            value = { sent, failure: failure instanceof Error ? failure.message : undefined };
            break;
          }
        }
        reply = { result: { ok: true, value } };
      } catch (error) {
        reply = {
          result: { ok: false, failure: encodeWorkboardSqliteFailure(error) },
          outcomeUnknown: hasSqliteWorkerOutcomeUnknown(error),
        };
      }
      return reply;
    },
    close: owner.close,
  };
}
