import { Tn as SilentReplyConversationType, i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { T as ReplyToMode } from "./types.base-DCoxbfrn.js";
import { s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { b as ReplyPayloadDelivery, c as MessagePresentation, n as InteractiveReply } from "./payload-BuuA629O.js";
import { t as OutboundSendDeps } from "./send-deps--cyJDjZ7.js";
import { t as OutboundMediaAccess } from "./load-options-Dc-kAx-U.js";
import { b as OutboundPayloadDeliveryOutcome, l as OutboundIdentity, t as ChannelDeliveryCapabilities, u as OutboundDeliveryFormattingOptions, y as OutboundDeliveryResult } from "./outbound.types-COmT4EQP.js";
import { v as resolveSendableOutboundReplyParts } from "./reply-payload-DjPL5qa-.js";
import { a as OutboundSessionContext, i as OutboundChannel, r as QueuedRenderedMessageBatchPlan, s as DeliveryMirror } from "./delivery-queue-D2AVDddh.js";

//#region src/infra/outbound/payloads.d.ts
type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
  audioAsVoice?: boolean;
  presentation?: MessagePresentation;
  delivery?: ReplyPayloadDelivery;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>; /** Hook-only content for audio-only TTS payloads. Never used as channel text/caption. */
  hookContent?: string;
};
type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  presentation?: MessagePresentation;
  delivery?: ReplyPayloadDelivery;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};
type OutboundPayloadPlan = {
  sourceIndex: number;
  payload: ReplyPayload;
  parts: ReturnType<typeof resolveSendableOutboundReplyParts>;
  hasPresentation: boolean;
  hasInteractive: boolean;
  hasChannelData: boolean;
};
type OutboundPayloadPlanContext = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
  /**
   * When true, bare silent payloads are dropped instead of being rewritten to
   * visible fallback text. Set by callers that know the parent session has at
   * least one pending spawned child whose completion will deliver the real
   * reply. If omitted, the outbound plan consults the registered runtime query
   * (see `pending-spawn-query.ts`).
   */
  hasPendingSpawnedChildren?: boolean;
  extractMarkdownImages?: boolean;
};
declare function createOutboundPayloadPlan(payloads: readonly ReplyPayload[], context?: OutboundPayloadPlanContext): OutboundPayloadPlan[];
declare function projectOutboundPayloadPlanForDelivery(plan: readonly OutboundPayloadPlan[]): ReplyPayload[];
declare function projectOutboundPayloadPlanForJson(plan: readonly OutboundPayloadPlan[]): OutboundPayloadJson[];
//#endregion
//#region src/infra/outbound/deliver.d.ts
type OutboundDeliveryQueuePolicy = "required" | "best_effort";
type OutboundDeliveryIntent = {
  id: string;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
};
type DurableFinalDeliveryRequirement = keyof NonNullable<ChannelDeliveryCapabilities["durableFinal"]>;
type DurableFinalDeliveryRequirements = Partial<Record<DurableFinalDeliveryRequirement, boolean>>;
type DeliverOutboundPayloadsCoreParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  mediaAccess?: OutboundMediaAccess;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void; /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
};
/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate.
 * New message lifecycle code should use `sendDurableMessageBatch` from
 * `src/channels/message/send.ts` or `deliverInboundReplyWithMessageSendContext`
 * from `src/channels/turn/durable-delivery.ts`. Keep direct use only for
 * outbound substrate, recovery, and compatibility paths.
 */
type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */skipQueue?: boolean; /** @internal Let recovery run commit hooks after it has acked the recovered queue entry. */
  deferCommitHooks?: boolean;
  queuePolicy?: OutboundDeliveryQueuePolicy;
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  onDeliveryIntent?: (intent: OutboundDeliveryIntent) => void;
};
/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate.
 * New message lifecycle code should use `sendDurableMessageBatch` from
 * `src/channels/message/send.ts` or `deliverInboundReplyWithMessageSendContext`
 * from `src/channels/turn/durable-delivery.ts`. Keep direct use only for
 * outbound substrate, recovery, and compatibility paths.
 */
declare function deliverOutboundPayloads(params: DeliverOutboundPayloadsParams): Promise<OutboundDeliveryResult[]>;
//#endregion
export { OutboundDeliveryQueuePolicy as a, projectOutboundPayloadPlanForDelivery as c, OutboundDeliveryIntent as i, projectOutboundPayloadPlanForJson as l, DurableFinalDeliveryRequirement as n, deliverOutboundPayloads as o, DurableFinalDeliveryRequirements as r, createOutboundPayloadPlan as s, DeliverOutboundPayloadsParams as t };