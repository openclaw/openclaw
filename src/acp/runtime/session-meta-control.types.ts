import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { AcpSessionReadInput } from "./session-meta-read.types.js";

export type AcpSessionRuntimeLocator = Readonly<
  Pick<SessionAcpMeta, "backend" | "runtimeSessionName">
>;

/** A cleanup target constraint; live task and actor authority remain separate. */
export type AcpSessionControlBinding = Readonly<{
  sessionId: string;
  lifecycleRevision?: string;
  sessionStartedAt?: number;
  ownerKey: string;
}>;

export type AcpSessionSourceReadInput = {
  source: {
    agentId: string;
    path: string;
    identity: DatabasePathIdentity;
  };
  entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "sessionStartedAt">;
  sessionKey: string;
  agentId: string;
  expectedControlBinding?: AcpSessionControlBinding;
};

/** Declarative target constraints are rechecked inside the owning worker transaction. */
export type AcpSessionControlConstraint = AcpSessionSourceReadInput & {
  sharedSource: { path: string; identity: DatabasePathIdentity };
  ownerKey: string | undefined;
  runtimeLocator?: AcpSessionRuntimeLocator;
  read: Omit<AcpSessionReadInput, "entry">;
};
