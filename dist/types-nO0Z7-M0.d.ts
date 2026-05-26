//#region src/commitments/types.d.ts
type CommitmentKind = "event_check_in" | "deadline_check" | "care_check_in" | "open_loop";
type CommitmentSensitivity = "routine" | "personal" | "care";
type CommitmentStatus = "pending" | "sent" | "dismissed" | "snoozed" | "expired";
type CommitmentSource = "inferred_user_context" | "agent_promise";
type CommitmentScope = {
  agentId: string;
  sessionKey: string;
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  senderId?: string;
};
type CommitmentDueWindow = {
  earliestMs: number;
  latestMs: number;
  timezone: string;
};
type CommitmentRecord = CommitmentScope & {
  id: string;
  kind: CommitmentKind;
  sensitivity: CommitmentSensitivity;
  source: CommitmentSource;
  status: CommitmentStatus;
  reason: string;
  suggestedText: string;
  dedupeKey: string;
  confidence: number;
  dueWindow: CommitmentDueWindow;
  sourceMessageId?: string;
  sourceRunId?: string; /** @deprecated Legacy-only field from early stores. Do not replay this into delivery prompts. */
  sourceUserText?: string; /** @deprecated Legacy-only field from early stores. Do not replay this into delivery prompts. */
  sourceAssistantText?: string;
  createdAtMs: number;
  updatedAtMs: number;
  attempts: number;
  lastAttemptAtMs?: number;
  sentAtMs?: number;
  dismissedAtMs?: number;
  snoozedUntilMs?: number;
  expiredAtMs?: number;
};
type CommitmentStoreFile = {
  version: 1;
  commitments: CommitmentRecord[];
};
type CommitmentCandidate = {
  itemId: string;
  kind: CommitmentKind;
  sensitivity: CommitmentSensitivity;
  source: CommitmentSource;
  reason: string;
  suggestedText: string;
  dedupeKey: string;
  confidence: number;
  dueWindow: {
    earliest: string;
    latest?: string;
    timezone?: string;
  };
};
type CommitmentExtractionItem = CommitmentScope & {
  itemId: string;
  nowMs: number;
  timezone: string;
  userText: string;
  assistantText?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
  existingPending: Array<{
    kind: CommitmentKind;
    reason: string;
    dedupeKey: string;
    earliestMs: number;
    latestMs: number;
  }>;
};
type CommitmentExtractionBatchResult = {
  candidates: CommitmentCandidate[];
};
//#endregion
export { CommitmentScope as a, CommitmentRecord as i, CommitmentExtractionBatchResult as n, CommitmentStatus as o, CommitmentExtractionItem as r, CommitmentStoreFile as s, CommitmentCandidate as t };