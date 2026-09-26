import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { AcpSessionControlBinding } from "./session-control-owner.js";
import type { AcpSessionReadInput } from "./session-meta-keys.js";

export type AcpSessionMutationDecision =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; meta: SessionAcpMeta };

export type AcpSessionMutationPreparation = {
  entry?: SessionEntry;
  current?: SessionAcpMeta;
  currentRowKey?: string;
  preparedEntry: SessionEntry;
};

export type AcpSessionMutationSource = {
  agentId: string;
  path: string;
  identity: DatabasePathIdentity;
};

export type AcpSessionMutationCommit = {
  agentId: string;
  storageSessionKey: string;
  sessionKey: string;
  entry?: SessionEntry;
  currentRowKey?: string;
  updatedAt: number;
  decision: Exclude<AcpSessionMutationDecision, { kind: "keep" }>;
  source: AcpSessionMutationSource;
  expectedControlBinding?: AcpSessionControlBinding;
};

export type AcpSessionWriteOperations = {
  "acp.prepareMutation": {
    input: {
      nonce: string;
      read: AcpSessionReadInput;
      entry?: SessionEntry;
      updatedAt: number;
      source: AcpSessionMutationSource;
      sessionKey: string;
      agentId: string;
      expectedControlBinding?: AcpSessionControlBinding;
    };
    output: AcpSessionMutationPreparation;
  };
  "acp.commitMutation": {
    input: AcpSessionMutationCommit & { nonce: string };
    output: { nonce: string };
  };
};
