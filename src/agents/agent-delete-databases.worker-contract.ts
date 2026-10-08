import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOwnerInspection } from "../state/openclaw-agent-db-contract.js";

export type AgentDeleteDatabaseReadOperations = {
  "agentRetirement.inspectOwner": {
    input: { identity: DatabasePathIdentity };
    output: OpenClawAgentDatabaseOwnerInspection;
  };
};
