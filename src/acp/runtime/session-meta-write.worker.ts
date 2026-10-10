import { randomUUID } from "node:crypto";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import {
  legacyAcpMigrationBindingMatches,
  recordLegacyAcpMigrationCompletion,
} from "../../infra/legacy-acp-migration-source.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
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
  AcpSessionMutationPreparation,
  AcpSessionMutationPrepareInput,
  AcpSessionMutationSource,
} from "./session-meta-write.types.js";

export const acpSessionOperations = {
  "acp.prepareMutation": (input: AcpSessionMutationPrepareInput, { write }) =>
    prepareAcpSessionMutationInWorker(write, input),
  "acp.commitMutation": (input: AcpSessionMutationCommit & { nonce: string }, { write }) =>
    commitAcpSessionMutationInWorker(write, input),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

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

function readMutationSource(
  input: Omit<Parameters<typeof readAcpSessionSourceInWorker>[0], "source" | "entry"> & {
    source: AcpSessionMutationSource;
    entry?: SessionEntry;
  },
  phase: "metadata preparation" | "legacy source consumption",
) {
  if ("kind" in input.source) {
    // The host grant revalidates this exact actor snapshot; never reopen its sentinel.
    const current =
      input.source.kind === "reset" ? { entry: input.entry, sources: [] } : input.source.snapshot;
    assertAcpSessionMutationEntry(
      current.entry,
      input.entry ?? null,
      input.expectedControlBinding,
      phase,
    );
    return current;
  }
  return readAcpSessionSourceInWorker({ ...input, source: input.source }, phase);
}

function prepareAcpSessionMutationInWorker(
  write: WorkerWriteOperationContext["write"],
  input: AcpSessionMutationPrepareInput,
): AcpSessionMutationPreparation {
  return write(
    (database) => {
      const { db } = database;
      const controlled = input.control
        ? readControlledAcpSessionMutation(database, input.control)
        : undefined;
      const { entry } = controlled ?? readMutationSource(input, "metadata preparation");
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
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { nonce: input.nonce, preparation },
      });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: { nonce: input.nonce } });
      return preparation;
    },
    { operationLabel: "acp.metadata.prepare" },
  );
}

function consumeSources(database: OpenClawStateDatabase, input: AcpSessionMutationCommit) {
  const current = readMutationSource(input, "legacy source consumption");
  for (const source of current.sources) {
    if (legacyAcpMigrationBindingMatches(source, current.entry)) {
      recordLegacyAcpMigrationCompletion(database.db, source, input.updatedAt);
    }
  }
}

function commitAcpSessionMutationInWorker(
  write: WorkerWriteOperationContext["write"],
  input: AcpSessionMutationCommit & { nonce: string },
) {
  return write(
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
      const facts = applyAcpSessionMutation(db, input);
      const receipt = { nonce: input.nonce, facts };
      deferSqliteWorkerCommitReceipt(db, receipt);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      return receipt;
    },
    { operationLabel: "acp.metadata.commit" },
  );
}
