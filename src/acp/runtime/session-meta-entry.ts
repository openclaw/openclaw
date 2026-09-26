import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { retainSessionEntryWorkerPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { kickSessionEntryMaintenanceAfterWrite } from "../../config/sessions/session-accessor.sqlite-maintenance-kick.js";
import { withSessionEntryWorker } from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import {
  resolveSqliteTranscriptArchiveDirectory,
  type ResolvedSqliteScope,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntryReadWorkerOwner } from "../../config/sessions/session-entry-read-runtime.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "../../config/sessions/session-history-eviction.js";
import type { ResolvedSessionMaintenanceConfig } from "../../config/sessions/store-maintenance.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { AcpSessionControlBinding } from "./session-control-owner.js";
import type { AcpSessionEntryExpectation } from "./session-meta-entry.kernel.js";
import type {
  AcpSessionEntryMutation,
  AcpSessionEntryMutationResult,
} from "./session-meta-entry.types.js";

export async function updateAcpSessionStoreEntry(params: {
  options: OpenClawAgentDatabaseOptions & { path: string };
  scope: ResolvedSqliteScope;
  storePath: string;
  execution: OpenClawAgentDatabaseExecution;
  assertCurrent: () => void;
  readOwner: SessionEntryReadWorkerOwner;
  mutation: AcpSessionEntryMutation;
  expectedEntry: AcpSessionEntryExpectation;
  expectedControlBinding?: AcpSessionControlBinding;
  prepareMaintenance: () => Promise<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
}): Promise<AcpSessionEntryMutationResult> {
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
  let result: AcpSessionEntryMutationResult | undefined;
  const { options, execution, scope } = params;
  const maintenanceConfig = await params.prepareMaintenance();
  params.assertCurrent();
  await withSessionEntryWorker(
    options,
    execution.fileIdentity?.physicalIdentity,
    params.assertCurrent,
    async (owner, source) => {
      source.onRegistryChange = params.readOwner.onRegistryChange;
      await params.readOwner.refreshBeforeDispatch?.(() => owner.assertCurrent());
      await owner.prepare(source);
      params.assertCurrent();
      const identity = owner.fileIdentity;
      if (!identity) {
        throw new Error("ACP entry mutation has no admitted physical owner");
      }
      publication = retainSessionEntryWorkerPublication({
        agentId: options.agentId,
        storePath: options.path,
        databaseIdentity: identity.physicalIdentity,
      });
      const executed = await owner.runExisting(source, async (worker) => {
        const outcome = await worker
          .execute({
            type: "session.entry.acp",
            input: {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              mutation: params.mutation,
              expectedEntry:
                params.expectedEntry === null
                  ? null
                  : {
                      sessionId: params.expectedEntry.sessionId,
                      lifecycleRevision: params.expectedEntry.lifecycleRevision,
                      sessionStartedAt: params.expectedEntry.sessionStartedAt,
                    },
              expectedControlBinding: params.expectedControlBinding,
            },
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        if (admitted) {
          await admitted.retained.settled;
          const receipt = admitted.admission.committed?.facts;
          if (isRecord(receipt) && receipt.kind === "acp-entry-mutation") {
            // SAFETY: this command's retained native receipt is emitted by its paired finite kernel.
            result = receipt.result as AcpSessionEntryMutationResult;
          }
          const unknown = admitted.admission.settlement?.kind !== "completed" || !result;
          const published = publication?.settle(result?.publication, unknown);
          if (published) {
            publishCommittedSessionIdentity(
              scope.agentId,
              identity.physicalIdentity,
              published.previous,
              published.current,
            );
          }
          if (unknown) {
            throw new SqliteWorkerError(
              "ACP entry mutation has no confirmed native settlement",
              "outcome-unknown",
            );
          }
        }
        if (!outcome.ok) {
          throw outcome.error;
        }
        result ??= outcome.value;
        return result;
      });
      if (!executed) {
        throw new Error("ACP entry database disappeared before mutation");
      }
      await params.readOwner.revalidateTarget?.();
    },
    (admission, retained, facts) => {
      admitted = { admission, retained };
      if (
        isRecord(facts) &&
        isRecord(facts.publication) &&
        facts.publication.kind === "session-entry-replacements"
      ) {
        // SAFETY: the paired canonical entry kernel supplies the existing publication contract.
        const receipt = facts.publication as NonNullable<
          AcpSessionEntryMutationResult["publication"]
        >;
        publication?.begin(receipt.changedKeys, receipt.membershipInvalidatedKeys);
      }
    },
    execution,
  );
  if (!result) {
    throw new Error("ACP entry mutation returned no result");
  }
  params.assertCurrent();
  if (result.publication) {
    kickSessionEntryMaintenanceAfterWrite({
      activeSessionKey: scope.sessionKey,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(scope),
      scope,
      skipMaintenance: params.skipMaintenance,
      maintenanceConfig,
      storePath: params.storePath,
    });
  }
  kickSessionHistoryDiskBudgetMaintenance({
    agentId: scope.agentId,
    env: scope.env,
    storePath: params.storePath,
    maintenanceConfig,
  });
  return result;
}
