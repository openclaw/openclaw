import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusEvent,
  QaBusMessage,
  QaBusPollInput,
  QaBusPollResult,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
} from "./runtime-api.js";

export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(raw?: string): string {
  const trimmed = raw?.trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

export function normalizeConversationFromTarget(target: string): {
  conversation: QaBusConversation;
  threadId?: string;
} {
  const trimmed = target.trim();
  if (trimmed.startsWith("thread:")) {
    const rest = trimmed.slice("thread:".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      return {
        conversation: { id: rest.slice(0, slash), kind: "channel" },
        threadId: rest.slice(slash + 1),
      };
    }
  }
  if (trimmed.startsWith("channel:")) {
    return {
      conversation: { id: trimmed.slice("channel:".length), kind: "channel" },
    };
  }
  if (trimmed.startsWith("group:")) {
    return {
      conversation: { id: trimmed.slice("group:".length), kind: "group" },
    };
  }
  if (trimmed.startsWith("dm:")) {
    return {
      conversation: { id: trimmed.slice("dm:".length), kind: "direct" },
    };
  }
  return {
    conversation: { id: trimmed, kind: "direct" },
  };
}

export function cloneMessage(message: QaBusMessage): QaBusMessage {
  return {
    ...message,
    conversation: { ...message.conversation },
    attachments: (message.attachments ?? []).map((attachment) => cloneAttachment(attachment)),
    reactions: message.reactions.map((reaction) => ({ ...reaction })),
  };
}

function cloneAttachment(attachment: QaBusAttachment): QaBusAttachment {
  return { ...attachment };
}

export function cloneEvent(event: QaBusEvent): QaBusEvent {
  switch (event.kind) {
    case "inbound-message":
    case "outbound-message":
    case "message-edited":
    case "message-deleted":
    case "reaction-added":
      return { ...event, message: cloneMessage(event.message) };
    case "thread-created":
      return { ...event, thread: { ...event.thread } };
  }
  throw new Error("Unsupported QA bus event kind");
}

export function buildQaBusSnapshot(params: {
  cursor: number;
  conversations: Map<string, QaBusConversation>;
  threads: Map<string, QaBusThread>;
  messages: Map<string, QaBusMessage>;
  events: QaBusEvent[];
}): QaBusStateSnapshot {
  const conversations: QaBusConversation[] = [];
  for (const conversation of params.conversations.values()) {
    conversations.push({ ...conversation });
  }
  const threads: QaBusThread[] = [];
  for (const thread of params.threads.values()) {
    threads.push({ ...thread });
  }
  const messages: QaBusMessage[] = [];
  for (const message of params.messages.values()) {
    messages.push(cloneMessage(message));
  }
  const events: QaBusEvent[] = [];
  for (const event of params.events) {
    events.push(cloneEvent(event));
  }
  return {
    cursor: params.cursor,
    conversations,
    threads,
    messages,
    events,
  };
}

export function readQaBusMessage(params: {
  messages: Map<string, QaBusMessage>;
  input: QaBusReadMessageInput;
}) {
  const message = params.messages.get(params.input.messageId);
  if (!message) {
    throw new Error(`qa-bus message not found: ${params.input.messageId}`);
  }
  return cloneMessage(message);
}

export function searchQaBusMessages(params: {
  messages: Map<string, QaBusMessage>;
  input: QaBusSearchMessagesInput;
}) {
  const accountId = normalizeAccountId(params.input.accountId);
  const limit = Math.max(1, Math.min(params.input.limit ?? 20, 100));
  const query = normalizeOptionalLowercaseString(params.input.query);
  const matches: QaBusMessage[] = [];
  for (const message of params.messages.values()) {
    if (message.accountId !== accountId) {
      continue;
    }
    if (params.input.conversationId && message.conversation.id !== params.input.conversationId) {
      continue;
    }
    if (params.input.threadId && message.threadId !== params.input.threadId) {
      continue;
    }
    if (query) {
      const messageText = normalizeOptionalLowercaseString(message.text) ?? "";
      let matched = messageText.includes(query);
      for (let index = 0; !matched && index < (message.attachments?.length ?? 0); index += 1) {
        const attachment = message.attachments?.[index];
        matched =
          attachmentValueIncludes(attachment?.fileName, query) ||
          attachmentValueIncludes(attachment?.altText, query) ||
          attachmentValueIncludes(attachment?.transcript, query) ||
          attachmentValueIncludes(attachment?.mimeType, query);
      }
      if (!matched) {
        continue;
      }
    }
    matches.push(cloneMessage(message));
    if (matches.length > limit) {
      matches.splice(0, matches.length - limit);
    }
  }
  return matches;
}

function attachmentValueIncludes(value: string | undefined, query: string): boolean {
  return Boolean(value && value.toLowerCase().includes(query));
}

export function pollQaBusEvents(params: {
  events: QaBusEvent[];
  cursor: number;
  input?: QaBusPollInput;
}): QaBusPollResult {
  const accountId = normalizeAccountId(params.input?.accountId);
  const startCursor = params.input?.cursor ?? 0;
  const effectiveStartCursor = params.cursor < startCursor ? 0 : startCursor;
  const limit = Math.max(1, Math.min(params.input?.limit ?? 100, 500));
  const matches: QaBusEvent[] = [];
  for (const event of params.events) {
    if (event.accountId !== accountId || event.cursor <= effectiveStartCursor) {
      continue;
    }
    matches.push(cloneEvent(event));
    if (matches.length >= limit) {
      break;
    }
  }
  return {
    cursor: params.cursor,
    events: matches,
  };
}
