/** Subagent announce flow parameter and outcome types. */
import type { ContinuationRecipientAuthorityBinding } from "../../../config/sessions/session-recipient-authority-types.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import type { PendingFinalDeliveryPayload } from "../registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export type SubagentAnnounceFlowOutcome =
  | NonNullable<SubagentAnnounceDeliveryResult["disposition"]>
  | "requester_waiting";

export type SubagentAnnounceFlowParams = Omit<
  PendingFinalDeliveryPayload,
  "requesterDisplayKey"
> & {
  childAgentId?: string;
  childSessionIdentity?: { sessionId: string; lifecycleRevision?: string };
  runTimeoutSeconds?: number;
  requesterAgentId?: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /** Cached pre-wake result for legacy runs without terminal facts. */
  fallbackReply?: string;
  /** Deliver only frozen terminal facts; never inspect or mutate the child session. */
  suppressChildSessionEffects?: boolean;
  /** Refresh database currency before child-session reads or effects. */
  prepareChildSessionEffects?: () => Promise<boolean>;
  /** Synchronous host-owner check immediately before child-session effects. */
  isChildSessionEffectsAllowed?: () => boolean;
  /** Live owner check for requester delivery after awaited phases. */
  isCompletionDeliveryAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  /** Exact source reserved synchronously by the durable registry handoff. */
  controllerInput?: SessionControllerInput;
  signal?: AbortSignal;
  onAccepted?: () => void;
  onExecutionStarted?: () => void;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  silentAnnounce?: boolean;
  wakeOnReturn?: boolean;
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  continuationRecipientAuthorityBinding?: ContinuationRecipientAuthorityBinding;
  persistContinuationRecipientAuthorityBinding?: (
    binding: ContinuationRecipientAuthorityBinding,
  ) => boolean | Promise<boolean>;
  traceparent?: string;
  onBeforeDeleteChildSession?: () => boolean | Promise<boolean>;
  resolveGatewayContext?: GatewayContextResolver;
  /** A killed child produces no further output, so its notice never waits for one. */
  endedReason?: SubagentRunRecord["endedReason"];
};
