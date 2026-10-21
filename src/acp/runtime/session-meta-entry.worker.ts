import { writeSessionEntryPatchInDatabase } from "../../config/sessions/session-accessor.sqlite-entry-mutation.js";
import { readSessionEntrySelectionSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "../../config/sessions/session-accessor.sqlite-replacement-state.js";
import { assertCanonicalSessionKeyWrite } from "../../config/sessions/session-canonical-key.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { assertAcpSessionMutationEntry } from "./session-meta-entry.kernel.js";
import type {
  AcpSessionEntryMutationInput,
  AcpSessionEntryMutationResult,
} from "./session-meta-entry.types.js";

/** Finite ACP field changes use the canonical entry kernel and its commit publication. */
export function mutateAcpSessionEntryInWorker(
  opened: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: AcpSessionEntryMutationInput,
  admit: (stage: "transaction" | "commit", publication?: unknown) => void,
  ownReceipt = true,
): AcpSessionEntryMutationResult {
  assertCanonicalSessionKeyWrite(input.sessionKey, input.agentId);
  return runOpenClawAgentWriteTransaction(
    (database) => {
      if (database.db !== opened.db) {
        throw new Error("ACP entry mutation lost its canonical database owner");
      }
      admit("transaction");
      const prepared = readSessionEntrySelectionSnapshot(database, input.sessionKey, true, true);
      const existing = prepared[0]?.entry;
      assertAcpSessionMutationEntry(
        existing,
        input.expectedEntry,
        input.expectedControlBinding,
        "entry mutation",
      );
      const mutation = input.mutation;
      const base = existing ?? (mutation.kind === "touch" ? mutation.fallbackEntry : undefined);
      if (!base) {
        const result = { entry: null };
        if (ownReceipt) {
          deferSqliteWorkerCommitReceipt(database.db, { kind: "acp-entry-mutation", result });
        }
        admit("commit");
        return result;
      }
      const next =
        mutation.kind === "touch"
          ? mergeSessionEntry(base, { updatedAt: mutation.updatedAt })
          : structuredClone(base);
      delete next.acp;
      const changed = writeSessionEntryPatchInDatabase(database, {
        fresh: prepared,
        sessionKey: input.sessionKey,
        writeBase: base,
        next,
        options: {},
      });
      const publication = changed.identity
        ? prepareSessionEntryReplacementPublication(
            {
              pendingArchiveRecovery: false,
              previous: changed.identity.previous,
              current: changed.identity.current,
              maintenancePlans: [],
              membershipInvalidatedKeys: [],
            },
            database,
            { postimages: changed.postimages },
          )
        : undefined;
      const result = { entry: changed.entry, ...(publication ? { publication } : {}) };
      if (ownReceipt) {
        deferSqliteWorkerCommitReceipt(database.db, { kind: "acp-entry-mutation", result });
      }
      admit("commit", publication);
      return result;
    },
    options,
    { operationLabel: "session-entry.acp" },
  );
}
