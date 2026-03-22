import type { DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import type { SubagentEscalationStage, SubagentEscalationTier } from "./subagent-escalation.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn-modes.js";

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  /** Number of announce delivery attempts that returned false (deferred). */
  announceRetryCount?: number;
  /** Timestamp of the last announce retry attempt (for backoff). */
  lastAnnounceRetryAt?: number;
  /** Terminal lifecycle reason recorded when the run finishes. */
  endedReason?: SubagentLifecycleEndedReason;
  /** Run ended while descendants were still pending and should be re-invoked once they settle. */
  wakeOnDescendantSettle?: boolean;
  /**
   * Latest frozen completion output captured for announce delivery.
   * Seeded at first end transition and refreshed by later assistant turns
   * while completion delivery is still pending for this session.
   */
  frozenResultText?: string | null;
  /** Timestamp when frozenResultText was last captured. */
  frozenResultCapturedAt?: number;
  /**
   * Fallback completion output preserved across wake continuation restarts.
   * Used when a late wake run replies with NO_REPLY after the real final
   * summary was already produced by the prior run.
   */
  fallbackFrozenResultText?: string | null;
  /** Timestamp when fallbackFrozenResultText was preserved. */
  fallbackFrozenResultCapturedAt?: number;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  resolvedAgentId?: string;
  resolvedTeamId?: string | null;
  resolvedCapability?: string | null;
  roleAliasUsed?: boolean;
  escalationStage?: SubagentEscalationStage;
  escalationTier?: SubagentEscalationTier;
  taskTag?: string;
};
