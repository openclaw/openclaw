import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.contracts.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import type { GatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-receipt.types.js";
import type { SubagentCompletionDeliveryState } from "../registry/subagent-registry-read.types.js";

type SubagentDeliveryPath = "steered" | "direct" | "queued" | "none";
type SubagentAnnounceDeliveryDisposition = NonNullable<
  SubagentCompletionDeliveryState["disposition"]
>;
type SubagentAnnounceDeliveryFailureReason =
  | "completion_handoff_pending"
  | "completion_handoff_unavailable"
  | "delivery_suppressed"
  | "generated_media_missing"
  | "message_tool_delivery_missing"
  | "operator_authority_unavailable"
  | "requester_abandoned"
  | "requester_turn_pending"
  | "source_owner_changed"
  | "steer_dropped"
  | "visible_reply_missing";

export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  /** Direct delivery that already committed the requester's visible final. */
  requesterVisibleFinalDelivered?: true;
  storeReplaced?: true;
  /** Bounded visible final returned by the direct requester synthesis turn. */
  finalAssistantVisibleText?: string;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
  // Stops fallback delivery when ownership changed or another terminal result
  // makes trying a second path unsafe.
  terminal?: boolean;
  disposition?: SubagentAnnounceDeliveryDisposition;
  missingMediaUrls?: string[];
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";

type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
};

export type SubagentAnnounceDirectParams = {
  requesterSessionKey: string;
  requesterAgentId?: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  completionRequesterLifecycleRevision?: string;
  requireVisibleReply?: boolean;
  requireDirectDelivery?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceTool?: string;
  settleWakeSourceSessionKeys?: readonly string[];
  isSourceSessionEffectsAllowed?: () => boolean;
  sourceReceiptAdmission?: GatewayToolCallerReceiptAdmission;
  /** Reconcile an already-admitted public settle turn; never dispatch or send. */
  recoveryReceiptOnly?: true;
  /** Additional source guard released by the accepting Gateway or injection owner. */
  isSourceSessionAdmissionAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterIsSubagent: boolean;
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  onDeliveryError?: (error: unknown) => void;
  signal?: AbortSignal;
  onAccepted?: (payload: unknown) => void;
  onExecutionStarted?: () => void;
  onBeforeDispatch?: () => void | Promise<void>;
  resolveGatewayContext?: GatewayContextResolver;
  controllerInput?: SessionControllerInput;
};

export function sourceOwnerChangedResult(): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "none",
    reason: "source_owner_changed",
    error: "subagent source lifecycle changed before completion delivery",
    terminal: true,
    disposition: "intentional_non_delivery",
  };
}
