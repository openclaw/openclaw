import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withCronReceiptAuthorityMutation } from "../cron/store/receipt-authority-owner.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";

/** Atomically claim a completed deletion tombstone for a newly created identity. */
export function claimCompletedAgentDeletion(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<boolean> {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  return withCronReceiptAuthorityMutation(context, async (mutation) =>
    runOpenClawStateWorkerOperation(
      mutation.context,
      (scope) =>
        scope.execute({
          type: "agentDeletion.claimCompleted",
          input: {
            agentId: normalizeAgentId(agentId),
            operationId,
            nonce: mutation.attachment.nonce,
          },
        }),
      {
        assertCurrent: mutation.assertCurrent,
        createAdmission: (operation) => {
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Agent creation claim requires transaction admission");
            }
            mutation.assertCurrent();
            grant();
          });
          mutation.observe(admission, operation, (facts) => {
            if (
              !isRecord(facts) ||
              facts.kind !== "agent-deletion-claimed" ||
              facts.agentId !== normalizeAgentId(agentId) ||
              facts.operationId !== operationId ||
              typeof facts.claimed !== "boolean"
            ) {
              throw new Error("Agent creation claim lost its committed journal facts");
            }
            if (facts.claimed) {
              try {
                (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
              } catch {
                return;
              }
              sessionChanges.emit({ all: true, scope: "stores" });
            }
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    ),
  );
}
