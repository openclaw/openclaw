import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";

export type AgentDeletionSessionStoreTargets = {
  stores: string[];
  candidates: { path: string; identity: DatabasePathIdentity }[];
};

export type AgentDeletionSessionStoreSafetyInput = {
  config: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  targets: AgentDeletionSessionStoreTargets;
};

export type AgentDeletionSessionStoreReadOperations = {
  "agentDeletion.sessionStoreBlocker": {
    input: AgentDeletionSessionStoreSafetyInput & {
      databasePath: string;
    };
    output: { type: "agentDeletion.sessionStoreBlocker"; blocker: string | undefined };
  };
};

export type AgentDeletionSessionStoreAbsentReadOperations = {
  "agentRetirement.sessionStoreBlocker": {
    input: AgentDeletionSessionStoreSafetyInput;
    output: { blocker: string | undefined };
  };
};
