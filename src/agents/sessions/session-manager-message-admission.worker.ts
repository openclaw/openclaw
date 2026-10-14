import type { DatabaseSync } from "node:sqlite";
import {
  runWithSessionPendingInputWorkerCustody,
  type SessionPendingInputWorkerReceipt,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { SessionMetadataMessageControl } from "../../config/sessions/session-manager-write-contract.js";
import { readSessionPendingInputAuthorityFacts } from "../../config/sessions/session-pending-input-authority.kernel.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";

export type MetadataWorkerAdmission = (
  stage: "transaction" | "commit",
  restriction?: AgentDatabaseAdmissionRestriction,
) => void;

export function runWithMetadataMessageAdmission<T>(
  context: {
    admit: MetadataWorkerAdmission;
    database: DatabaseSync;
    databasePath: string;
    checkMessage: (facts: unknown) => void;
  },
  controls: SessionMetadataMessageControl | undefined,
  run: (admit: MetadataWorkerAdmission, beforeFreshMessageCommit: () => void) => T,
): { value: T; pendingInputReceipt?: SessionPendingInputWorkerReceipt } {
  let transactionFacts: unknown;
  let pendingAuthorityChecked = false;
  const readAuthority = () => {
    const source = controls?.pendingInput?.facts;
    // Foreign custody keeps its original host owner's live assertion.
    if (source?.preparedAuthority && source.databasePath !== context.databasePath) {
      return null;
    }
    return source?.preparedAuthority && source.agentId && source.databaseAgentId
      ? readSessionPendingInputAuthorityFacts(
          { db: context.database, path: context.databasePath, agentId: source.databaseAgentId },
          source.sessionKey,
          source.agentId,
        )
      : undefined;
  };
  const requestMessageCheck = (check: "pending" | "fresh") => {
    context.checkMessage({
      kind: "session-message",
      domainFacts: transactionFacts,
      check,
      authority: check === "pending" ? readAuthority() : undefined,
    });
    if (check === "pending") {
      pendingAuthorityChecked = true;
    }
  };
  const admit: MetadataWorkerAdmission = (stage) =>
    context.admit(stage, (request, dispatch) => {
      transactionFacts = request.facts;
      dispatch({
        ...request,
        facts: {
          kind: "session-message",
          domainFacts: request.facts,
          ...(stage === "commit" && pendingAuthorityChecked ? { check: "pending" } : {}),
          ...(stage === "commit" && pendingAuthorityChecked ? { authority: readAuthority() } : {}),
        },
      });
    });
  const write = () => run(admit, () => requestMessageCheck("fresh"));
  const pending = controls?.pendingInput;
  if (!pending) {
    return { value: write() };
  }
  const result = runWithSessionPendingInputWorkerCustody(
    pending.facts,
    pending.relocation,
    () => requestMessageCheck("pending"),
    write,
  );
  return { value: result.value, pendingInputReceipt: result.receipt };
}
