import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type {
  AcpSessionControlBinding,
  AcpSessionControlConstraint,
  AcpSessionSourceReadInput,
} from "./session-meta-control.types.js";
import type { AcpSessionReadInput } from "./session-meta-read.types.js";

export type AcpSessionMutationSource =
  | AcpSessionSourceReadInput["source"]
  | (AcpSessionSourceReadInput["source"] & { kind: "reset" })
  | {
      kind: "memory";
      agentId: string;
      path: string;
      snapshot: { entry: SessionEntry | undefined; sources: [] };
    };

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
  source: AcpSessionMutationSource;
  expectedControlBinding?: AcpSessionControlBinding;
  control?: AcpSessionControlConstraint;
};

export type AcpSessionMutationPrepareInput = {
  nonce: string;
  read: AcpSessionReadInput;
  entry?: SessionEntry;
  updatedAt: number;
  source: Exclude<AcpSessionMutationSource, { kind: "reset" }>;
  sessionKey: string;
  agentId: string;
  expectedControlBinding?: AcpSessionControlBinding;
  control?: AcpSessionControlConstraint;
};
