import { setTimeout as sleep } from "node:timers/promises";
import {
  createFailureAwareTransportWaitForCondition,
  findFailureOutboundMessage as findTransportFailureOutboundMessage,
  waitForQaTransportCondition,
  type QaTransportState,
} from "./qa-transport.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type { QaBusMessage } from "./runtime-api.js";

function findFailureOutboundMessage(
  state: QaTransportState,
  options?: { sinceIndex?: number; cursorSpace?: "all" | "outbound" },
) {
  return findTransportFailureOutboundMessage(state, options);
}

function createScenarioWaitForCondition(state: QaTransportState) {
  return createFailureAwareTransportWaitForCondition(state);
}

async function waitForOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
  options?: { sinceIndex?: number },
) {
  return await waitForQaTransportCondition(() => {
    const failureMessage = findFailureOutboundMessage(state, options);
    if (failureMessage) {
      throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
    }
    const startIndex = options?.sinceIndex ?? 0;
    let outboundIndex = 0;
    let match: QaBusMessage | undefined;
    for (const message of state.getSnapshot().messages) {
      if (message.direction !== "outbound") {
        continue;
      }
      if (outboundIndex >= startIndex && predicate(message)) {
        match = message;
        break;
      }
      outboundIndex += 1;
    }
    if (!match) {
      return undefined;
    }
    const failureReply = extractQaFailureReplyText(match.text);
    if (failureReply) {
      throw new Error(failureReply);
    }
    return match;
  }, timeoutMs);
}

async function waitForNoOutbound(state: QaTransportState, timeoutMs = 1_200) {
  await sleep(timeoutMs);
  let outboundCount = 0;
  for (const message of state.getSnapshot().messages) {
    if (message.direction === "outbound") {
      outboundCount += 1;
    }
  }
  if (outboundCount > 0) {
    throw new Error(`expected no outbound messages, saw ${outboundCount}`);
  }
}

function recentOutboundSummary(state: QaTransportState, limit = 5) {
  const recent: string[] = [];
  for (const message of state.getSnapshot().messages) {
    if (message.direction !== "outbound") {
      continue;
    }
    recent.push(`${message.conversation.id}:${message.text}`);
    if (recent.length > limit) {
      recent.splice(0, recent.length - limit);
    }
  }
  return recent.join(" | ");
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
  const messages: QaBusMessage[] = [];
  for (const message of state.getSnapshot().messages) {
    if (message.conversation.id !== params.conversationId) {
      continue;
    }
    if (params.threadId && message.threadId !== params.threadId) {
      continue;
    }
    if (params.direction && message.direction !== params.direction) {
      continue;
    }
    messages.push(message);
    if (params.limit && messages.length > params.limit) {
      messages.splice(0, messages.length - params.limit);
    }
  }
  return messages;
}

function formatTransportTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
  },
) {
  const messages = readTransportTranscript(state, params);
  const lines: string[] = [];
  for (const message of messages) {
    const direction = message.direction === "inbound" ? "USER" : "ASSISTANT";
    const speaker = message.senderName?.trim() || message.senderId;
    let attachmentSummary = "";
    if (message.attachments && message.attachments.length > 0) {
      const attachments: string[] = [];
      for (const attachment of message.attachments) {
        attachments.push(`${attachment.kind}:${attachment.fileName ?? attachment.id}`);
      }
      attachmentSummary = ` [attachments: ${attachments.join(", ")}]`;
    }
    lines.push(`${direction} ${speaker}: ${message.text}${attachmentSummary}`);
  }
  return lines.join("\n\n");
}

function formatConversationTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    limit?: number;
  },
) {
  return formatTransportTranscript(state, params);
}

async function waitForTransportOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs?: number,
) {
  return await waitForOutboundMessage(state, predicate, timeoutMs);
}

async function waitForChannelOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs?: number,
) {
  return await waitForTransportOutboundMessage(state, predicate, timeoutMs);
}

async function waitForNoTransportOutbound(state: QaTransportState, timeoutMs = 1_200) {
  await waitForNoOutbound(state, timeoutMs);
}

export {
  createScenarioWaitForCondition,
  findFailureOutboundMessage,
  formatConversationTranscript,
  formatTransportTranscript,
  readTransportTranscript,
  recentOutboundSummary,
  waitForChannelOutboundMessage,
  waitForNoOutbound,
  waitForNoTransportOutbound,
  waitForOutboundMessage,
  waitForTransportOutboundMessage,
};
