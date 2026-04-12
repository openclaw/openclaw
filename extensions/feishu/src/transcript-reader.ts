import fs from "node:fs";
import path from "node:path";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { FeishuMessageInfo } from "./types.js";

type TranscriptMessageMeta = {
  channel?: string;
  chatId?: string;
  chatType?: "direct" | "group";
  providerMessageId?: string;
  providerMessageIds?: string[];
  parentId?: string;
  threadId?: string | number;
};

type TranscriptLine = {
  id?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    openclawMessageMeta?: TranscriptMessageMeta;
    timestamp?: number;
  };
};

/**
 * Read Feishu messages from the local session transcript.
 * Includes both inbound user messages and outbound delivery mirrors.
 * Returns messages newest-first (consistent with Feishu API and journal ordering).
 */
export function readFeishuMessagesFromTranscript(params: {
  sessionId: string;
  agentId?: string;
  store?: string;
  chatId?: string;
  messageId?: string;
  limit?: number;
}): FeishuMessageInfo[] {
  const { sessionId, agentId, store, chatId, messageId, limit = 20 } = params;
  if (!sessionId) return [];

  const transcriptPath = resolveTranscriptPath(sessionId, agentId, store);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const messages: FeishuMessageInfo[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }

      const msg = parsed.message;
      if (!msg) continue;

      const meta = msg.openclawMessageMeta;
      if (!meta || meta.channel !== "feishu") continue;

      const resolvedMessageId = meta.providerMessageId ?? meta.providerMessageIds?.at(-1);

      // Single-message lookup by providerMessageId.
      if (messageId) {
        if (resolvedMessageId === messageId || meta.providerMessageIds?.includes(messageId)) {
          return [transcriptEntryToFeishuMessage(msg, meta, resolvedMessageId)];
        }
        continue;
      }

      // Chat history lookup by chatId.
      if (chatId && meta.chatId !== chatId) continue;

      messages.push(transcriptEntryToFeishuMessage(msg, meta, resolvedMessageId));
    }

    if (messageId) return []; // not found

    // Take the most recent `limit` messages, return newest-first
    // (consistent with Feishu API ByCreateTimeDesc and journal ordering).
    const recent = messages.length > limit ? messages.slice(-limit) : messages;
    recent.reverse();
    return recent;
  } catch {
    return [];
  }
}

function resolveTranscriptPath(
  sessionId: string,
  agentId?: string,
  store?: string,
): string | undefined {
  try {
    const storePath = resolveStorePath(store, { agentId });
    // storePath = ~/<state>/agents/<agentId>/sessions/sessions.json
    // transcript = ~/<state>/agents/<agentId>/sessions/<sessionId>.jsonl
    return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  } catch {
    return undefined;
  }
}

function transcriptEntryToFeishuMessage(
  msg: NonNullable<TranscriptLine["message"]>,
  meta: TranscriptMessageMeta,
  resolvedMessageId?: string,
): FeishuMessageInfo {
  const textContent = msg.content
    ?.filter((block) => block.type === "text" && block.text)
    .map((block) => block.text ?? "")
    .join("\n");

  return {
    messageId: resolvedMessageId ?? "",
    chatId: meta.chatId ?? "",
    chatType: meta.chatType === "group" ? "group" : meta.chatType === "direct" ? "p2p" : undefined,
    senderType: msg.role === "assistant" ? "app" : undefined,
    content: textContent ?? "",
    contentType: "text",
    createTime: msg.timestamp,
    threadId: typeof meta.threadId === "string" ? meta.threadId : undefined,
  };
}
