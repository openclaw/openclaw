import { randomUUID } from "node:crypto";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { readLegacyAcpMigrationContextInDatabase } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import {
  legacyAcpMigrationBindingMatches,
  recordLegacyAcpMigrationCompletion,
} from "../../infra/legacy-acp-migration-source.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { assertAcpSessionMutationEntry } from "./session-meta-entry.kernel.js";
import { selectAcpSessionRowForRead } from "./session-meta-keys.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { applyAcpSessionMutation } from "./session-meta-write.kernel.js";
import type {
  AcpSessionMutationCommit,
  AcpSessionMutationDecision,
  AcpSessionMutationPreparation,
  AcpSessionWriteOperations,
} from "./session-meta-write.types.js";

export function prepareAcpSessionMutationInWorker(
  database: OpenClawStateDatabase,
  input: AcpSessionWriteOperations["acp.prepareMutation"]["input"],
): AcpSessionMutationPreparation {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { entry } = readCurrentSource(input, "metadata preparation");
      const row = selectAcpSessionRowForRead(db, { ...input.read, entry });
      const preparation: AcpSessionMutationPreparation = {
        entry,
        current: row ? rowToAcpSessionMeta(row) : undefined,
        currentRowKey: row?.session_key,
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

function readCurrentSource(
  input: Pick<
    AcpSessionMutationCommit,
    "source" | "entry" | "sessionKey" | "agentId" | "expectedControlBinding"
  >,
  phase: "metadata preparation" | "legacy source consumption",
) {
  const source = input.source;
  const assertSource = () => {
    const observed = readDatabasePathIdentitySync(source.path);
    if (
      observed.key !== source.identity.key ||
      observed.canonicalPath !== source.identity.canonicalPath ||
      observed.birthtime !== source.identity.birthtime
    ) {
      throw new Error(`Canonical ACP session changed before ${phase}.`);
    }
  };
  assertSource();
  const read = withFreshOpenClawAgentDatabaseReadOnly(
    (agent) =>
      readLegacyAcpMigrationContextInDatabase(
        agent,
        resolveSqliteSessionKey(input.sessionKey, input.agentId),
      ),
    { agentId: source.agentId, path: source.path, env: getSqliteWorkerStateContext().environment },
  );
  assertSource();
  if (!read.found && read.reason !== "database-missing") {
    throw new Error("Canonical ACP session is unavailable before source consumption");
  }
  const current = read.found ? read.value : { entry: undefined, sources: [] };
  assertAcpSessionMutationEntry(
    current.entry,
    input.entry ?? null,
    input.expectedControlBinding,
    phase,
  );
  return current;
}

function consumeSources(database: OpenClawStateDatabase, input: AcpSessionMutationCommit) {
  const current = readCurrentSource(input, "legacy source consumption");
  for (const source of current.sources) {
    if (legacyAcpMigrationBindingMatches(source, current.entry)) {
      recordLegacyAcpMigrationCompletion(database.db, source, input.updatedAt);
    }
  }
}

export function commitAcpSessionMutationInWorker(
  database: OpenClawStateDatabase,
  input: AcpSessionWriteOperations["acp.commitMutation"]["input"],
) {
  return runOpenClawStateWriteTransaction(
    (current) => {
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { nonce: input.nonce },
      });
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
