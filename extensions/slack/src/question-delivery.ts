import type { ActionsBlock } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { buildSlackCompleteBlocksFallbackText } from "./blocks-fallback.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import {
  isSlackQuestionActionForQuestion,
  resolveSlackQuestionActionIds,
  SLACK_QUESTION_FINALIZATION_BLOCKS,
} from "./reply-action-ids.js";
import type { SlackSendResult } from "./send.js";

export function registerSlackQuestionDelivery(params: {
  questionId: string;
  accountId?: string;
  result: Pick<SlackSendResult, "channelId" | "messageId" | "meta">;
  text: string;
  update: (message: {
    channelId: string;
    messageTs: string;
    text: string;
    blocks: (Block | KnownBlock)[];
  }) => Promise<void>;
}): void {
  const blocks = params.result.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS];
  if (!blocks || resolveSlackQuestionActionIds(blocks, params.questionId).length === 0) {
    return;
  }
  const messageId = params.result.meta?.slackQuestionMessageId ?? params.result.messageId;
  const text = params.text || buildSlackCompleteBlocksFallbackText(blocks);
  questionGatewayRuntime.registerChannelDelivery({
    questionId: params.questionId,
    deliveryId: `slack:${params.accountId ?? "default"}:${params.result.channelId}:${messageId}`,
    finalize: async (statusLine) => {
      const escapedStatusLine = escapeSlackMrkdwn(statusLine);
      const displayBlocks = blocks.flatMap((block): (Block | KnownBlock)[] => {
        if (block.type !== "actions") {
          return [block];
        }
        // SAFETY: Slack accepted these blocks, and an actions block has ActionsBlock elements.
        const actions = block as ActionsBlock;
        const elements = actions.elements.filter(
          (element) => !isSlackQuestionActionForQuestion(element, params.questionId),
        );
        return elements.length ? [{ ...actions, elements }] : [];
      });
      await params.update({
        channelId: params.result.channelId,
        messageTs: messageId,
        text: `${text}\n\n${escapedStatusLine}`,
        blocks: [
          ...displayBlocks,
          { type: "context", elements: [{ type: "mrkdwn", text: escapedStatusLine }] },
        ],
      });
    },
  });
}
