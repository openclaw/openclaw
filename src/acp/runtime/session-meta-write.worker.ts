import { randomUUID } from "node:crypto";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import {
  legacyAcpMigrationBindingMatches,
  recordLegacyAcpMigrationCompletion,
} from "../../infra/legacy-acp-migration-source.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { AcpSessionControlConstraint } from "./session-meta-control.types.js";
import { assertAcpSessionMutationEntry } from "./session-meta-entry.kernel.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
  selectAcpSessionRowForRead,
} from "./session-meta-keys.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import {
  readAcpSessionControlInWorker,
  readAcpSessionSourceInWorker,
} from "./session-meta-source.worker.js";
import { applyAcpSessionMutation } from "./session-meta-write.kernel.js";
import type {
  AcpSessionMutationCommit,
  AcpSessionMutationDecision,
  AcpSessionMutationPreparation,
  AcpSessionWriteOperations,
} from "./session-meta-write.types.js";

export function executeAcpSessionMutationInWorker(
  database: OpenClawStateDatabase,
  command: SqliteWorkerCommand<AcpSessionWriteOperations>,
) {
  return command.type === "acp.prepareMutation"
    ? prepareAcpSessionMutationInWorker(database, command.input)
    : commitAcpSessionMutationInWorker(database, command.input);
}

function readControlledAcpSessionMutation(
  database: OpenClawStateDatabase,
  control: AcpSessionControlConstraint,
) {
  const { entry, row } = readAcpSessionControlInWorker(database, control);
  if (!entry || !row) {
    throw new Error("ACP controlled metadata is no longer present before mutation");
  }
  const destination = selectAcpSessionRow(
    database.db,
    buildAcpDatabaseSessionKey(control.sessionKey, control.agentId),
  );
  // Read selection can skip an incompatible canonical row in favor of a legacy alias.
  // A conditional update must not overwrite that other lifecycle when canonicalizing.
  if (destination && !acpSessionRowMatchesEntry(destination, entry)) {
    throw new Error("ACP controlled metadata destination binding changed before mutation");
  }
  return { entry, row };
}

function prepareAcpSessionMutationInWorker(
  database: OpenClawStateDatabase,
  input: AcpSessionWriteOperations["acp.prepareMutation"]["input"],
): AcpSessionMutationPreparation {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const controlled = input.control
        ? readControlledAcpSessionMutation(database, input.control)
        : undefined;
      const { entry } = controlled ?? readAcpSessionSourceInWorker(input, "metadata preparation");
      if (controlled) {
        assertAcpSessionMutationEntry(
          entry,
          input.entry ?? null,
          input.expectedControlBinding,
          "metadata preparation",
        );
      }
      const row = controlled?.row ?? selectAcpSessionRowForRead(db, { ...input.read, entry });
      const preparation: AcpSessionMutationPreparation = {
        entry,
        current: row ? rowToAcpSessionMeta(row) : undefined,
        currentRowKey: row?.session_key,
        currentRowSessionId: row?.session_id,
        preparedEntry: mergeSessionEntry(entry, {
          updatedAt: input.updatedAt,
          ...(entry ? {} : { lifecycleRevision: randomUUID() }),
        }),
      };
      const { port1, port2 } = new MessageChannel();
      try {
        requestSqliteWorkerOperationAdmission(
          {
            stage: "transaction",
            facts: { nonce: input.nonce, preparation, preparationPort: port2 },
          },
          [port2],
        );
        // SAFETY: only the retained host callback can reply on this command's private port.
        const decision = receiveMessageOnPort(port1)?.message as
          | AcpSessionMutationDecision
          | undefined;
        if (!decision) {
          throw new Error("ACP metadata callback returned no admitted decision");
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: { nonce: input.nonce } });
        return preparation;
      } finally {
        port1.close();
        port2.close();
      }
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "acp.metadata.prepare" },
  );
}

function consumeSources(database: OpenClawStateDatabase, input: AcpSessionMutationCommit) {
  const current = readAcpSessionSourceInWorker(input, "legacy source consumption");
  for (const source of current.sources) {
    if (legacyAcpMigrationBindingMatches(source, current.entry)) {
      recordLegacyAcpMigrationCompletion(database.db, source, input.updatedAt);
    }
  }
}

function commitAcpSessionMutationInWorker(
  database: OpenClawStateDatabase,
  input: AcpSessionWriteOperations["acp.commitMutation"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    (current) => {
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { nonce: input.nonce },
      });
      if (input.control) {
        const { row } = readControlledAcpSessionMutation(current, input.control);
        if (
          row.session_key !== input.currentRowKey ||
          row.session_id !== input.currentRowSessionId
        ) {
          throw new Error("ACP controlled metadata binding changed before commit");
        }
      }
      consumeSources(current, input);
      const db = current.db;
      applyAcpSessionMutation(db, input);
      const receipt = { nonce: input.nonce };
      deferSqliteWorkerCommitReceipt(db, receipt);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      return receipt;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "acp.metadata.commit" },
  );
}
