// iMessage transport binding for numbered ask_user reactions.
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeIMessageGuid } from "./message-guid.js";
import { resolveIMessageReactionContext } from "./monitor/reaction-context.js";
import type { IMessagePayload } from "./monitor/types.js";

type IMessageQuestionReactionIdentity = { accountId: string; messageGuid: string };

function buildKey(identity: IMessageQuestionReactionIdentity): string | null {
  const account = identity.accountId.trim();
  const guid = normalizeIMessageGuid(identity.messageGuid);
  return account && guid ? `${account}:${guid}` : null;
}

const questionReactionTargets = createQuestionReactionTargetStore({
  channel: "imessage",
  channelDisplayName: "iMessage",
  buildKey,
  registerChannelDelivery: questionGatewayRuntime.registerChannelDelivery,
  resolveReaction: questionGatewayRuntime.resolveReaction,
});

function resolveQuestionReaction(params: {
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
}) {
  const reaction = resolveIMessageReactionContext(params.message, params.bodyText);
  if (!reaction || reaction.action !== "added") {
    return null;
  }
  const guids = [
    ...new Set((reaction.targetGuids ?? []).map(normalizeIMessageGuid).filter(Boolean)),
  ];
  if (guids.length === 0) {
    return null;
  }
  const optionIndex = questionGatewayRuntime.resolveReactionIndex(reaction.emoji);
  return optionIndex === undefined
    ? null
    : {
        optionIndex,
        identities: guids.map((messageGuid) => ({ accountId: params.accountId, messageGuid })),
      };
}

export function registerIMessageQuestionReactionTargetForDeliveredPayload(params: {
  accountId: string;
  target: { channel: string };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
}): boolean {
  const binding = questionGatewayRuntime.readReactionBinding(params.payload);
  if (params.target.channel !== "imessage" || !binding) {
    return false;
  }
  let registered = false;
  for (const result of params.results) {
    if (result.channel !== "imessage") {
      continue;
    }
    const guid =
      typeof result.meta?.imessageMessageGuid === "string"
        ? result.meta.imessageMessageGuid
        : result.messageId;
    if (/^\d+$/u.test(normalizeIMessageGuid(guid))) {
      continue;
    }
    registered =
      questionReactionTargets.register(binding, {
        accountId: params.accountId,
        messageGuid: guid,
      }) || registered;
  }
  return registered;
}

export function hasIMessageQuestionReactionTarget(params: {
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
}): boolean {
  const reaction = resolveQuestionReaction(params);
  return reaction ? questionReactionTargets.has(reaction.identities) : false;
}

export async function maybeResolveIMessageQuestionReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  senderId: string;
  gatewayUrl?: string;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  const reaction = resolveQuestionReaction(params);
  if (!reaction) {
    return false;
  }
  return await questionReactionTargets.resolve({
    ...reaction,
    cfg: params.cfg,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    logDebug: params.logDebug,
  });
}
