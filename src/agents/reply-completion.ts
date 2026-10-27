import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveSilentReplySettings } from "../config/silent-reply.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import {
  isExecCompletionInputProvenance,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel-constants.js";
import { isDeliverableMessageChannel } from "../utils/message-channel-normalize.js";
import type { AdmittedRunContext } from "./admitted-run-context.js";
import type { AgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.types.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import type {
  ReplyCompletion,
  ReplyCompletionEvidence,
  ReplyExpectation,
} from "./reply-completion.types.js";
import type { EmbeddedRunTrigger } from "./run-trigger.js";

export type { ReplyCompletion, ReplyExpectation } from "./reply-completion.types.js";

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

export const MISSING_REPLY_NOTICE_TEXT = "No answer was returned. Ask again if you still need one.";
export const MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT = `${MISSING_REPLY_NOTICE_TEXT} Note: some tool actions may have already been executed — please verify before retrying.`;

/** Only host-authored missing-reply copy may cross the terminal error egress boundary. */
export function isHostMissingReplyNoticeText(text: string | undefined): boolean {
  return text === MISSING_REPLY_NOTICE_TEXT || text === MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT;
}

export function createMissingReplyNotice(text = MISSING_REPLY_NOTICE_TEXT): ReplyPayload {
  return setReplyPayloadMetadata(
    { text, isError: true, isStatusNotice: true },
    { assistantTranscriptOwned: true, deliverDespiteSourceReplySuppression: true },
  );
}

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
  const provenance = params.opts.inputProvenance;
  if (
    provenance?.kind === "inter_session" &&
    (provenance.sourceTool === "subagent_announce" || provenance.sourceTool === "subagent_settle")
  ) {
    // Completion processing consumes child findings; it does not owe another answer.
    return "optional";
  }
  const inputExpectation = params.opts.replyExpectation;
  if (inputExpectation === "optional" || inputExpectation === "result-required") {
    return inputExpectation;
  }
  if (
    params.opts.privateCompletion ||
    params.opts.lane === AGENT_LANE_SUBAGENT ||
    isSubagentSessionKey(params.sessionKey)
  ) {
    return "result-required";
  }
  // The wake prompt offers NO_REPLY, so silence stays valid on internal surfaces too.
  if (isExecCompletionInputProvenance(params.opts.inputProvenance)) {
    return "optional";
  }
  if (
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
  scheduledAutomation?: boolean;
}): boolean {
  return (
    params.scheduledAutomation === true ||
    params.inputProvenance?.kind === "inter_session" ||
    params.inputProvenance?.kind === "internal_system"
  );
}
/** Resolve legacy runtime inputs once; explicit host requiredness always wins. */
export function resolveReplyExpectation(params: {
  runId?: string;
  lifecycleGeneration?: string;
  admittedRunContext?: Pick<AdmittedRunContext, "operationalRunInstance">;
  terminalReplyExpectation?: ReplyExpectation;
  allowEmptyAssistantReplyAsSilent?: boolean;
  scheduledAutomation?: boolean;
  trigger?: EmbeddedRunTrigger;
  inputProvenance?: InputProvenance;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "chatType">;
  messageChannel?: string;
  lane?: string;
  privateCompletion?: true;
}): ReplyExpectation {
  const commandExpectation =
    params.terminalReplyExpectation ??
    resolveCommandReplyExpectation({
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
  const expectation =
    commandExpectation ??
    (isSyntheticSourceReplyTurn(params) ||
    (params.allowEmptyAssistantReplyAsSilent ??
      (params.trigger !== undefined && params.trigger !== "user" && params.trigger !== "manual"))
      ? "optional"
      : "required");
  const accepted = readAcceptedUserReplyExpectation(params);
  return accepted
    ? expectation === "result-required" || accepted === "result-required"
      ? "result-required"
      : "required"
    : expectation;
}

function readAcceptedUserReplyExpectation(
  params: Pick<
    Parameters<typeof resolveReplyExpectation>[0],
    "runId" | "lifecycleGeneration" | "admittedRunContext"
  >,
): Exclude<ReplyExpectation, "optional"> | undefined {
  const context = params.runId ? getAgentRunContext(params.runId) : undefined;
  const accepted = context?.acceptedUserReply;
  if (
    !accepted ||
    (context?.isControlUiVisible === false && context.projectSessionMessages === false) ||
    (params.lifecycleGeneration !== undefined &&
      params.lifecycleGeneration !== context?.lifecycleGeneration) ||
    (params.admittedRunContext !== undefined &&
      params.admittedRunContext.operationalRunInstance !== accepted.operationalRunInstance)
  ) {
    return undefined;
  }
  return accepted.expectation;
}

/** Background failures are recorded; only an admitted user's missing answer needs chat text. */
export function shouldDeliverMissingReplyNotice(
  params: Parameters<typeof resolveReplyExpectation>[0] & {
    currentInboundEventKind?: InboundEventKind;
  },
): boolean {
  if (readAcceptedUserReplyExpectation(params)) {
    return true;
  }
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

/** A host claim can waive a required result; an empty model response cannot. */
export function resolveClaimedReplyExpectation(
  expectation: ReplyExpectation,
  meta: { providerStarted?: boolean; terminalReply?: AgentRunTerminalReplySnapshot } | undefined,
): ReplyExpectation {
  return meta?.providerStarted === false && meta.terminalReply?.disposition === "silent"
    ? "optional"
    : expectation;
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
