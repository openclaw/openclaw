import type {
  AgentDeletionInput,
  AgentDeletionJournalTransport,
} from "../state/agent-deletion-journal-transport.js";
import { readAgentDeletionJournalAsync } from "../state/agent-deletion-journal.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
import { withOpenClawStateLeaseRemoteAdmission } from "../state/openclaw-state-lease-worker-owner.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { AgentDeletionCommitUncertainError } from "./agent-deletion-errors.js";

type RemoteJournalOwner = {
  lease: OpenClawStateWorkerLeaseContext;
  context: OpenClawStateWorkerContext;
  transport: AgentDeletionJournalTransport;
  assertCurrent: () => void;
};

/** The serving Cron owner mutates history; the original deletion lease retains the remote outcome. */
export async function beginRemoteAgentDeletionJournal(
  owner: RemoteJournalOwner,
  entry: AgentDeletionInput,
  operationId: string,
) {
  owner.assertCurrent();
  const previousEntry = await readAgentDeletionJournalAsync(entry.agentId, {
    path: owner.context.admission.databasePath,
    env: owner.context.environment,
  });
  owner.assertCurrent();
  const journal = await withOpenClawStateLeaseRemoteAdmission(
    owner.lease,
    owner.context.admission.databasePath,
    (authority) =>
      owner.transport(
        { kind: "begin", entry, operationId, expectedJournal: previousEntry ?? null },
        authority,
      ),
  );
  if (
    !journal ||
    journal.agentId !== entry.agentId ||
    journal.operationId !== operationId ||
    journal.cleanupCompleted
  ) {
    throw new AgentDeletionCommitUncertainError("Gateway returned a different deletion journal");
  }
  owner.assertCurrent();
  return { entry: journal, previousEntry };
}

export async function rollbackRemoteAgentDeletionJournal(
  owner: RemoteJournalOwner,
  agentId: string,
  operationId: string,
): Promise<void> {
  owner.assertCurrent();
  const journal = await readAgentDeletionJournalAsync(agentId, {
    path: owner.context.admission.databasePath,
    env: owner.context.environment,
  });
  owner.assertCurrent();
  if (!journal || journal.operationId !== operationId || journal.cleanupCompleted) {
    throw new Error(`Agent ${agentId} deletion lost its journal before rollback.`);
  }
  const result = await withOpenClawStateLeaseRemoteAdmission(
    owner.lease,
    owner.context.admission.databasePath,
    (authority) => owner.transport({ kind: "rollback", journal }, authority),
  );
  if (result !== null) {
    throw new AgentDeletionCommitUncertainError("Gateway rollback returned a journal");
  }
  owner.assertCurrent();
}
