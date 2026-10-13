import type { Block, KnownBlock } from "@slack/web-api";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { SLACK_QUESTION_FINALIZATION_BLOCKS } from "./reply-action-ids.js";
import { formatSlackTarget, parseSlackTarget } from "./target-parsing.js";

export type SlackSendResult = {
  messageId: string;
  channelId: string;
  /** Workspace of the validated transport client; channelId stays platform-native. */
  teamId?: string;
  receipt: MessageReceipt;
  threadTs?: string;
  meta?: {
    slackQuestionActionIds: string[];
    slackQuestionMessageId?: string;
    [SLACK_QUESTION_FINALIZATION_BLOCKS]?: (Block | KnownBlock)[];
  };
};

/** Scope physical channel IDs with the workspace attested by the sending client. */
export function qualifySlackSendResult<T extends { channelId?: string; teamId?: string }>(
  result: T,
): T {
  if (!result.channelId || !result.teamId || parseSlackTarget(result.channelId)?.teamId) {
    return result;
  }
  return {
    ...result,
    channelId: formatSlackTarget({ teamId: result.teamId, kind: "channel", id: result.channelId }),
  };
}

export function toSlackOutboundResult<T extends { channelId?: string; teamId?: string }>(
  result: T,
) {
  const { channelId, ...delivery } = qualifySlackSendResult(result);
  return attachChannelToResult("slack", {
    ...delivery,
    ...(channelId === undefined ? {} : { target: { kind: "channel" as const, id: channelId } }),
  });
}

export function createSlackSendReceipt(params: {
  platformMessageIds: readonly string[];
  channelId?: string;
  teamId?: string;
  kind: MessageReceiptPartKind;
  threadTs?: string;
}): MessageReceipt {
  const platformMessageIds = params.platformMessageIds
    .map((messageId) => messageId.trim())
    .filter((messageId) => messageId && messageId !== "unknown");
  const { channelId } = qualifySlackSendResult(params);
  return createMessageReceiptFromOutboundResults({
    results: platformMessageIds.map((messageId) => {
      const result: MessageReceiptSourceResult = { channel: "slack", messageId };
      if (channelId) {
        result.channelId = channelId;
      }
      return result;
    }),
    kind: params.kind,
    threadId: params.threadTs,
  });
}

export function createSlackSendReceiptFromResults(
  results: readonly SlackSendResult[],
  threadTs?: string,
): MessageReceipt {
  const receipt = createMessageReceiptFromOutboundResults({
    results: results.map(qualifySlackSendResult),
    threadId: threadTs,
  });
  const thread = threadTs ? { threadId: threadTs } : {};
  for (const [index, part] of receipt.parts.entries()) {
    Object.assign(part, { index, ...thread });
  }
  return Object.assign(receipt, thread);
}

export function mergeSlackSendResults(results: readonly SlackSendResult[]): SlackSendResult {
  const lastResult = results.at(-1);
  if (!lastResult) {
    throw new Error("Slack send plan produced no delivery.");
  }
  if (results.length === 1) {
    return lastResult;
  }
  // A logical send can span media, rendered segments, and nested text chunks.
  // Keep every accepted ID while retaining the legacy final-message scalar fields.
  const receipt = createSlackSendReceiptFromResults(results);
  const questionResult = results.find((result) => result.meta?.slackQuestionActionIds.length);
  return {
    ...lastResult,
    receipt,
    ...(questionResult?.meta
      ? {
          meta: {
            ...questionResult.meta,
            slackQuestionMessageId:
              questionResult.meta.slackQuestionMessageId ?? questionResult.messageId,
          },
        }
      : {}),
  };
}
