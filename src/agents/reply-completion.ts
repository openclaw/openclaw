import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveSilentReplySettings } from "../config/silent-reply.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel-constants.js";
import { isDeliverableMessageChannel } from "../utils/message-channel-normalize.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import type { EmbeddedRunTrigger } from "./run-trigger.js";

export type ReplyExpectation = "required" | "optional" | "result-required";

export function isRequiredReplyExpectation(expectation: ReplyExpectation | undefined): boolean {
  return expectation === "required" || expectation === "result-required";
}
export type ReplyDeliveryState = "delivered" | "pending" | "missing";
export type ReplyDeliveryObserver = (
  minimumAssistantMessageIndex?: number,
) => Promise<ReplyDeliveryState>;
export type ReplyDeliveryFactsObserver = (minimumAssistantMessageIndex?: number) => Promise<{
  source: ReplyDeliveryState;
  terminal: ReplyDeliveryState;
}>;
type ReplyCompletionEvidence = "ready" | "delivered" | "pending" | "blocked" | "empty" | "silent";

export const MISSING_REPLY_NOTICE_TEXT = "No answer was returned. Ask again if you still need one.";

export function createMissingReplyNotice(text = MISSING_REPLY_NOTICE_TEXT): ReplyPayload {
  return setReplyPayloadMetadata(
    { text, isError: true, isStatusNotice: true },
    { assistantTranscriptOwned: true, deliverDespiteSourceReplySuppression: true },
  );
}

export type ReplyCompletion = {
  readonly expectation: ReplyExpectation;
  readonly outcome: ReplyCompletionEvidence | "missing";
};

const EMPTY_REPLY_CONFIG: OpenClawConfig = {};

export function resolveCommandReplyExpectation(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "chatType">;
  messageChannel?: string;
  opts: {
    lane?: string;
    privateCompletion?: true;
    inputProvenance?: InputProvenance;
    replyExpectation?: ReplyExpectation;
  };
}): ReplyExpectation | undefined {
  const inputExpectation = params.opts.replyExpectation;
  if (inputExpectation === "optional" || inputExpectation === "result-required") {
    return inputExpectation;
  }
  if (
    params.opts.privateCompletion ||
    params.opts.lane === AGENT_LANE_SUBAGENT ||
    isSubagentSessionKey(params.sessionKey) ||
    !params.messageChannel ||
    params.messageChannel === INTERNAL_MESSAGE_CHANNEL ||
    isInternalNonDeliveryChannel(params.messageChannel) ||
    !isDeliverableMessageChannel(params.messageChannel)
  ) {
    return "result-required";
  }
  if (inputExpectation === "required") {
    return inputExpectation;
  }
  if (params.opts.inputProvenance?.kind !== "inter_session") {
    return undefined;
  }
  const chatType = normalizeChatType(params.sessionEntry?.chatType);
  return resolveSilentReplySettings({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    surface: params.messageChannel,
    conversationType: chatType === "channel" ? "group" : chatType,
  }).policy === "allow"
    ? "optional"
    : "required";
}

/** Returns true when a lifecycle turn must not redefine session-stable reply policy. */
export function isSyntheticSourceReplyTurn(params: {
  inputProvenance?: InputProvenance;
  isHeartbeat?: boolean;
}): boolean {
  return (
    params.isHeartbeat === true ||
    params.inputProvenance?.kind === "inter_session" ||
    params.inputProvenance?.kind === "internal_system"
  );
}
/** Resolve legacy runtime inputs once; explicit host requiredness always wins. */
export function resolveReplyExpectation(params: {
  terminalReplyExpectation?: ReplyExpectation;
  allowEmptyAssistantReplyAsSilent?: boolean;
  trigger?: EmbeddedRunTrigger;
  inputProvenance?: InputProvenance;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "chatType">;
  messageChannel?: string;
  lane?: string;
  privateCompletion?: true;
}): ReplyExpectation {
  if (params.terminalReplyExpectation !== undefined) {
    return params.terminalReplyExpectation;
  }
  const commandExpectation = resolveCommandReplyExpectation({
    cfg: params.config ?? EMPTY_REPLY_CONFIG,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    messageChannel: params.messageChannel,
    opts: {
      lane: params.lane,
      privateCompletion: params.privateCompletion,
      inputProvenance: params.inputProvenance,
    },
  });
  return (
    commandExpectation ??
    (isSyntheticSourceReplyTurn(params) ||
    (params.allowEmptyAssistantReplyAsSilent ??
      (params.trigger !== undefined && params.trigger !== "user" && params.trigger !== "manual"))
      ? "optional"
      : "required")
  );
}

/** Background failures are recorded; only an admitted user's missing answer needs chat text. */
export function shouldDeliverMissingReplyNotice(
  params: Parameters<typeof resolveReplyExpectation>[0] & {
    isHeartbeat?: boolean;
    currentInboundEventKind?: InboundEventKind;
  },
): boolean {
  return (
    resolveReplyExpectation(params) === "required" &&
    !isSyntheticSourceReplyTurn(params) &&
    params.currentInboundEventKind !== "room_event" &&
    (params.trigger === undefined || params.trigger === "user" || params.trigger === "manual")
  );
}

/** Reconcile host policy with authored output and delivery custody. */
export function resolveReplyCompletion(
  expectation: ReplyExpectation,
  evidence: ReplyCompletionEvidence,
): ReplyCompletion {
  return {
    expectation,
    outcome:
      (evidence === "empty" && expectation !== "optional") ||
      (evidence === "silent" && expectation === "result-required")
        ? "missing"
        : evidence,
  };
}

/** Failure to observe a send is not proof that it is safe to generate or send another reply. */
export async function observeReplyDelivery(
  observer: ReplyDeliveryObserver | undefined,
  minimumAssistantMessageIndex: number,
  onError: (error: unknown) => void,
): Promise<ReplyDeliveryState> {
  try {
    return (await observer?.(minimumAssistantMessageIndex)) ?? "missing";
  } catch (error) {
    onError(error);
    return "pending";
  }
}
