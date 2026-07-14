import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentAnnounceTarget } from "./subagent-announce-target.types.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

export type RunSubagentAnnounceFlowParams = {
  requesterSessionKey: string;
  requesterDisplayKey: string;
  requesterOrigin?: DeliveryContext;
  targetRequesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  childSessionKey: string;
  childRunId: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  announceTarget?: SubagentAnnounceTarget;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  onBeforeDeleteChildSession?: () => boolean;
};
