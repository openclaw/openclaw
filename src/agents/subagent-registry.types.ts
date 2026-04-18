import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type StoredUserDeliveryPayloadSource =
  | "empty"
  | "child-blocks"
  | "named-section"
  | "sanitized-fallback";

export type StoredUserDeliveryPayload = {
  text: string;
  source: StoredUserDeliveryPayloadSource;
  capturedAt: number;
};

export type SubagentDeliveryClaim = {
  announceId: string;
  state: "claimed" | "delivered";
  token: string;
  path: "queued" | "steered" | "direct" | "none";
  claimedAt: number;
  updatedAt: number;
};

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
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;
  endedReason?: SubagentLifecycleEndedReason;
  wakeOnDescendantSettle?: boolean;
  frozenResultText?: string | null;
  frozenResultCapturedAt?: number;
  fallbackFrozenResultText?: string | null;
  fallbackFrozenResultCapturedAt?: number;
  endedHookEmittedAt?: number;
  completionAnnouncedAt?: number;
  deliveryClaim?: SubagentDeliveryClaim;
  userDeliveryPayload?: StoredUserDeliveryPayload | null;
  fallbackUserDeliveryPayload?: StoredUserDeliveryPayload | null;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
