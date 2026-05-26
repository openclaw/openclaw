import { Pn as SilentReplyConversationType, i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { T as ReplyToMode } from "./types.base-DS--yneR.js";
import { s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { V as RenderedMessageBatchPlanItem } from "./types-CxkJAgkR.js";
import { d as OutboundDeliveryFormattingOptions, u as OutboundIdentity } from "./outbound.types-D7agCOHK.js";
import { t as DeliverableMessageChannel } from "./message-channel-normalize-DJRT0sPp.js";
//#region src/infra/outbound/identity.d.ts
declare function normalizeOutboundIdentity(identity?: OutboundIdentity | null): OutboundIdentity | undefined;
declare function resolveAgentOutboundIdentity(cfg: OpenClawConfig, agentId: string): OutboundIdentity | undefined;
//#endregion
//#region src/infra/outbound/mirror.d.ts
type OutboundMirror = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
};
type DeliveryMirror = OutboundMirror & {
  /** Whether this message is being sent in a group/channel context */isGroup?: boolean; /** Group or channel identifier for correlation with received events */
  groupId?: string;
};
//#endregion
//#region src/infra/outbound/session-context.d.ts
type OutboundSessionContext = {
  /** Canonical session key used for internal hook dispatch. */key?: string; /** Session key used for policy resolution when delivery differs from the control session. */
  policyKey?: string; /** Explicit conversation type for policy resolution when a session key is generic. */
  conversationType?: SilentReplyConversationType; /** Active agent id used for workspace-scoped media roots. */
  agentId?: string; /** Originating account id used for requester-scoped group policy resolution. */
  requesterAccountId?: string; /** Originating sender id used for sender-scoped outbound media policy. */
  requesterSenderId?: string; /** Originating sender display name for name-keyed sender policy matching. */
  requesterSenderName?: string; /** Originating sender username for username-keyed sender policy matching. */
  requesterSenderUsername?: string; /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
  requesterSenderE164?: string;
};
declare function buildOutboundSessionContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
  policySessionKey?: string | null;
  conversationType?: string | null;
  isGroup?: boolean | null;
  agentId?: string | null;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
}): OutboundSessionContext | undefined;
//#endregion
//#region src/infra/outbound/targets.d.ts
type OutboundChannel = DeliverableMessageChannel;
//#endregion
//#region src/infra/outbound/delivery-queue-storage.d.ts
type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};
type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[]; /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: OutboundMirror; /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext; /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
};
interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  recoveryState?: "send_attempt_started" | "unknown_after_send";
}
//#endregion
//#region src/infra/outbound/delivery-queue-recovery.d.ts
type DeliverFn = (params: {
  cfg: OpenClawConfig;
} & QueuedDeliveryPayload & {
  deliveryQueueId?: string;
  deliveryQueueStateDir?: string;
  skipQueue?: boolean;
  deferCommitHooks?: boolean;
}) => Promise<unknown>;
interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
interface PendingDeliveryDrainDecision {
  match: boolean;
  bypassBackoff?: boolean;
}
declare function drainPendingDeliveries(opts: {
  drainKey: string;
  logLabel: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  deliver: DeliverFn;
  selectEntry: (entry: QueuedDelivery, now: number) => PendingDeliveryDrainDecision;
}): Promise<void>;
//#endregion
export { OutboundSessionContext as a, normalizeOutboundIdentity as c, OutboundChannel as i, resolveAgentOutboundIdentity as l, drainPendingDeliveries as n, buildOutboundSessionContext as o, QueuedRenderedMessageBatchPlan as r, DeliveryMirror as s, DeliverFn as t };