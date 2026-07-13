import type { AgentInternalEvent } from "./internal-events.js";
import type { DeliveryContext } from "./subagent-announce-origin.js";
import type { SubagentAnnounceTarget } from "./subagent-announce-target.js";

export type SendSubagentAnnounceDirectlyParams = {
  requesterSessionKey: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  requesterIsSubagent: boolean;
  announceTarget?: SubagentAnnounceTarget;
  signal?: AbortSignal;
};

export type DeliverSubagentAnnouncementParams = SendSubagentAnnounceDirectlyParams & {
  announceId?: string;
  steerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
};
