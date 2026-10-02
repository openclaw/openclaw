import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type {
  AcpSessionControlBinding,
  AcpSessionControlConstraint,
  AcpSessionSourceReadInput,
} from "./session-meta-control.types.js";
import type { AcpSessionReadInput } from "./session-meta-read.types.js";

export type AcpSessionMutationDecision =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; meta: SessionAcpMeta };

export type AcpSessionMutationPreparation = {
  entry?: SessionEntry;
  current?: SessionAcpMeta;
  currentRowKey?: string;
  currentRowSessionId?: string | null;
  preparedEntry: SessionEntry;
};

export type AcpSessionMutationCommit = {
  agentId: string;
  storageSessionKey: string;
  sessionKey: string;
  entry?: SessionEntry;
  currentRowKey?: string;
  currentRowSessionId?: string | null;
  updatedAt: number;
  decision: Exclude<AcpSessionMutationDecision, { kind: "keep" }>;
  source: AcpSessionSourceReadInput["source"];
  expectedControlBinding?: AcpSessionControlBinding;
  control?: AcpSessionControlConstraint;
};

export type AcpSessionMutationPrepareInput = {
  nonce: string;
  read: AcpSessionReadInput;
  entry?: SessionEntry;
  updatedAt: number;
  source: AcpSessionSourceReadInput["source"];
  sessionKey: string;
  agentId: string;
  expectedControlBinding?: AcpSessionControlBinding;
  control?: AcpSessionControlConstraint;
};
