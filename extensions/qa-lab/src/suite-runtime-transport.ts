import { setTimeout as sleep } from "node:timers/promises";
import type { QaBusState } from "./bus-state.js";
import {
  findFailureOutboundMessage,
  waitForQaTransportCondition,
  type QaTransportState,
} from "./qa-transport.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type { QaBusMessage } from "./runtime-api.js";

type WaitForNoOutboundOptions = {
  sinceIndex?: number;
};

async function waitForQaInboundCompletion(
  state: QaBusState,
  inbound: QaBusMessage,
  timeoutMs = 15_000,
) {
  const event = state
    .getSnapshot()
    .events.find(
      (candidate) =>
        candidate.kind === "inbound-message" &&
        candidate.accountId === inbound.accountId &&
        candidate.message.id === inbound.id,
    );
  if (!event) {
    throw new Error(`QA inbound event missing for ${inbound.id}`);
  }
  await waitForQaTransportCondition(
    () => state.getAcknowledgedPollCursor(inbound.accountId) >= event.cursor || undefined,
    timeoutMs,
  );
}

async function waitForCompletedQaReply(
  state: QaBusState,
  inbound: QaBusMessage,
  timeoutMs = 15_000,
) {
  await waitForQaInboundCompletion(state, inbound, timeoutMs);
  // Snapshots are clones. Read again after the channel has drained preview edits
  // and final delivery, rather than retaining the first streamed fragment.
  const replies = state
    .getSnapshot()
    .messages.filter(
      (message) =>
        message.direction === "outbound" &&
        !message.deleted &&
        message.accountId === inbound.accountId &&
        message.conversation.id === inbound.conversation.id &&
        message.conversation.kind === inbound.conversation.kind &&
        message.threadId === inbound.threadId &&
        message.replyToId === inbound.id,
    );
  for (const reply of replies) {
    const failure = extractQaFailureReplyText(reply);
    if (failure) {
      throw new Error(failure);
    }
  }
  const reply = replies.at(-1);
  if (!reply) {
    throw new Error(`QA inbound ${inbound.id} completed without a retained reply`);
  }
  return reply;
}

async function waitForOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
  options?: { accountId?: string; sinceIndex?: number },
) {
  return await waitForQaTransportCondition(() => {
    const failureMessage = findFailureOutboundMessage(state, options);
    if (failureMessage) {
      throw new Error(extractQaFailureReplyText(failureMessage) ?? failureMessage.text);
    }
    const match = state
      .getSnapshot()
      .messages.filter((message: QaBusMessage) => message.direction === "outbound")
      .slice(options?.sinceIndex ?? 0)
      .find(
        (message) =>
          !message.deleted &&
          (!options?.accountId || message.accountId === options.accountId) &&
          predicate(message),
      );
    if (!match) {
      return undefined;
    }
    const failureReply = extractQaFailureReplyText(match);
    if (failureReply) {
      throw new Error(failureReply);
    }
    return match;
  }, timeoutMs);
}

async function waitForNoOutbound(
  state: QaTransportState,
  timeoutMs = 1_200,
  options?: WaitForNoOutboundOptions,
) {
  await sleep(timeoutMs);
  const outbound = state
    .getSnapshot()
    .messages.filter((message: QaBusMessage) => message.direction === "outbound")
    .slice(options?.sinceIndex ?? 0);
  if (outbound.length > 0) {
    const summary = outbound
      .slice(0, 5)
      .map(
        (message: QaBusMessage) =>
          `${message.conversation.kind}:${message.conversation.id}:${message.senderId}:${message.text}`,
      )
      .join(" | ");
    throw new Error(`expected no outbound messages, saw ${outbound.length}: ${summary}`);
  }
}

function recentOutboundSummary(state: QaTransportState, limit = 5) {
  return state
    .getSnapshot()
    .messages.filter((message: QaBusMessage) => message.direction === "outbound")
    .slice(-limit)
    .map(({ accountId, conversation: { kind, id }, text }) => `${accountId}:${kind}:${id}:${text}`)
    .join(" | ");
}

function readTransportTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
  },
) {
  const messages = state
    .getSnapshot()
    .messages.filter(
      (message: QaBusMessage) =>
        message.conversation.id === params.conversationId &&
        (params.threadId ? message.threadId === params.threadId : true) &&
        (params.direction ? message.direction === params.direction : true),
    );
  return params.limit ? messages.slice(-params.limit) : messages;
}

function formatTransportTranscript(
  state: QaTransportState,
  params: Parameters<typeof readTransportTranscript>[1],
) {
  const messages = readTransportTranscript(state, params);
  return messages
    .map((message: QaBusMessage) => {
      const direction = message.direction === "inbound" ? "user" : "assistant";
      const speaker = message.senderName?.trim() || message.senderId;
      const attachmentSummary =
        message.attachments && message.attachments.length > 0
          ? ` [attachments: ${message.attachments
              .map(
                (attachment: NonNullable<QaBusMessage["attachments"]>[number]) =>
                  `${attachment.kind}:${attachment.fileName ?? attachment.id}`,
              )
              .join(", ")}]`
          : "";
      return `${direction.toUpperCase()} ${speaker}: ${message.text}${attachmentSummary}`;
    })
    .join("\n\n");
}

const formatConversationTranscript: (
  state: QaTransportState,
  params: Omit<Parameters<typeof readTransportTranscript>[1], "direction">,
) => string = formatTransportTranscript;

export {
  formatConversationTranscript,
  formatTransportTranscript,
  readTransportTranscript,
  recentOutboundSummary,
  waitForCompletedQaReply,
  waitForQaInboundCompletion,
  waitForNoOutbound,
  waitForNoOutbound as waitForNoTransportOutbound,
  waitForOutboundMessage,
};
