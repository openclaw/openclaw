import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import type { SessionFactsRead } from "../../gateway/session-sharing-preparation.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { CronCreatorAuthorityCapability } from "../cron-creator-authority-context.js";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";

/** Private retained authority contract; lifecycle and dispatch state stay with their owner. */
export type RequesterCronAuthority = {
  managementEntitlement?: NonNullable<CronCreatorAuthorityCapability["managementEntitlement"]>;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  releaseOperatorAuthority?: () => void;
  requesterOwner?: CronCreatorAuthorityCapability["requesterOwner"];
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterAgentId: string;
  requesterTurnRunId: string;
  lifecycleGeneration: string;
  sessionLifecycleRevision?: string;
  admittedRunId?: string;
  runScopeBound?: true;
  active: boolean;
} & (
  | {
      kind: "yield";
      sessionFacts: SessionFactsRead<PreparedSessionMutationFacts>;
      runs: ReadonlyMap<string, SubagentRunRecord>;
      batch: readonly SubagentRunRecord[];
      rearmGeneration?: number;
    }
  | {
      kind: "followup";
      sourceSessionKey: string;
      isFollowupCurrent: () => boolean;
      releaseFollowup: () => void;
    }
);
