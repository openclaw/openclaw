import type { SessionEntry } from "../../config/sessions/types.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type {
  AcpSessionControlBinding,
  AcpSessionRuntimeLocator,
} from "./session-control-owner.js";
import type { AcpSessionReadInput } from "./session-meta-keys.js";

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
