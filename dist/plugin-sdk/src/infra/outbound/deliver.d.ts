import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelDeliveryCapabilities } from "../../channels/plugins/types.adapters.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { type OutboundDeliveryResult, type OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import { type QueuedRenderedMessageBatchPlan } from "./delivery-queue.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import { type NormalizedOutboundPayload } from "./payloads.js";
import { type OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";
export type { OutboundDeliveryResult } from "./deliver-types.js";
export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
export { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";
export type OutboundDeliveryQueuePolicy = "required" | "best_effort";
export type OutboundDeliveryIntent = {
    id: string;
    channel: Exclude<OutboundChannel, "none">;
    to: string;
    accountId?: string;
    queuePolicy: OutboundDeliveryQueuePolicy;
};
export type DurableFinalDeliveryRequirement = keyof NonNullable<ChannelDeliveryCapabilities["durableFinal"]>;
export type DurableFinalDeliveryRequirements = Partial<Record<DurableFinalDeliveryRequirement, boolean>>;
export type OutboundDurableDeliverySupport = {
    ok: true;
} | {
    ok: false;
    reason: "missing_outbound_handler" | "capability_mismatch";
    capability?: DurableFinalDeliveryRequirement;
};
export declare function resolveOutboundDurableFinalDeliverySupport(params: {
    cfg: OpenClawConfig;
    channel: Exclude<OutboundChannel, "none">;
    requirements?: DurableFinalDeliveryRequirements;
}): Promise<OutboundDurableDeliverySupport>;
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
    onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
    /** Session/agent context used for hooks and media local-root scoping. */
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
export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
    /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
    skipQueue?: boolean;
    /** @internal Let recovery run commit hooks after it has acked the recovered queue entry. */
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
export declare function deliverOutboundPayloads(params: DeliverOutboundPayloadsParams): Promise<OutboundDeliveryResult[]>;
export declare function deliverOutboundPayloadsInternal(params: DeliverOutboundPayloadsParams): Promise<OutboundDeliveryResult[]>;
