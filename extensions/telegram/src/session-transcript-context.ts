import {
  readRecentUserAssistantTextForSession,
  type SessionRecentConversationText,
} from "openclaw/plugin-sdk/session-store-runtime";

type TelegramSessionTranscriptPromptMessage = {
  message_id?: string;
  sender: string;
  timestamp_ms?: number;
  body: string;
  source_channel?: string;
};

type BuildTelegramSessionTranscriptPromptMessagesParams = {
  agentId: string;
  beforeTimestampMs?: number;
  limit: number;
  minTimestampMs?: number;
  sessionKey: string;
  storePath?: string;
};

function toSessionTranscriptPromptMessage(
  entry: SessionRecentConversationText,
): TelegramSessionTranscriptPromptMessage {
  const sender = entry.role === "assistant" ? "OpenClaw" : "User";
  return {
    ...(entry.id ? { message_id: `session:${entry.id}` } : {}),
    sender: entry.sourceChannel ? `${sender} (${entry.sourceChannel})` : sender,
    ...(entry.timestamp !== undefined ? { timestamp_ms: entry.timestamp } : {}),
    body: entry.text,
    ...(entry.sourceChannel ? { source_channel: entry.sourceChannel } : {}),
  };
}

export async function buildTelegramSessionTranscriptPromptMessages(
  params: BuildTelegramSessionTranscriptPromptMessagesParams,
): Promise<TelegramSessionTranscriptPromptMessage[]> {
  const entries = await readRecentUserAssistantTextForSession({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    limit: params.limit,
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
    ...(params.beforeTimestampMs !== undefined
      ? { beforeTimestampMs: params.beforeTimestampMs }
      : {}),
    ...(params.minTimestampMs !== undefined ? { minTimestampMs: params.minTimestampMs } : {}),
  });
  return entries.map(toSessionTranscriptPromptMessage);
}
