// Discord plugin module implements reaction feedback capture behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { formatDiscordReactionEmoji } from "./format.js";
import type { DiscordReactionEvent } from "./listeners.reactions.js";
import type { DiscordListenerLogger } from "./listeners.queue.js";

type DiscordReactionCaptureRecord = {
  event_id: string;
  action: "added" | "removed";
  timestamp: string;
  guild_id: string;
  channel_id: string;
  thread_id?: string;
  message_id: string;
  reactor_id: string;
  author_id: string;
  message_author_id: string;
  emoji_name: string;
  emoji_type: string;
  emoji_id?: string;
  reacted_at?: string;
  assistant_message: true;
  config_version: string;
  message_provenance: "assistant";
  message_created_at?: string;
};

const DISCORD_REACTION_CAPTURE_QUEUE = new Map<string, Promise<void>>();

export function resolveDiscordReactionCapturePath(accountId: string): string {
  const safeAccountId = accountId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "default";
  return path.join(resolveStateDir(process.env), "discord", `${safeAccountId}-reaction-feedback.jsonl`);
}

export function resolveDiscordReactionConfigVersion(cfg: OpenClawConfig): string {
  const discordConfig = cfg.channels?.discord ?? {};
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(discordConfig)).digest("hex")}`;
}

export async function captureDiscordReactionFeedback(params: {
  cfg: OpenClawConfig;
  accountId: string;
  action: "added" | "removed";
  data: DiscordReactionEvent;
  botUserId?: string;
  fetchedMessage: { author?: { id?: string; bot?: boolean | null }; timestamp?: string } | null;
  threadId?: string;
  logger?: DiscordListenerLogger;
}): Promise<void> {
  const { fetchedMessage } = params;
  const author = fetchedMessage?.author;
  const assistantAuthor =
    Boolean(author?.id && params.botUserId && author.id === params.botUserId) ||
    (params.botUserId === undefined && Boolean(author?.bot));
  if (!assistantAuthor || !author?.id) {
    return;
  }

  const emojiName = formatDiscordReactionEmoji(params.data.emoji);
  const capturePath = resolveDiscordReactionCapturePath(params.accountId);
  const now = new Date().toISOString();
  const record: DiscordReactionCaptureRecord = {
    event_id: crypto
      .createHash("sha256")
      .update(
        [
          params.accountId,
          params.action,
          params.data.guild_id ?? "",
          params.data.channel_id,
          params.data.message_id,
          params.data.user.id,
          emojiName,
          now,
        ].join("|"),
      )
      .digest("hex"),
    action: params.action,
    timestamp: now,
    guild_id: params.data.guild_id ?? "",
    channel_id: params.data.channel_id,
    thread_id: params.threadId,
    message_id: params.data.message_id,
    reactor_id: params.data.user.id,
    author_id: author.id,
    message_author_id: author.id,
    emoji_name: emojiName,
    emoji_type: params.data.emoji.id ? "custom" : "unicode",
    emoji_id: params.data.emoji.id ?? undefined,
    reacted_at: now,
    assistant_message: true,
    config_version: resolveDiscordReactionConfigVersion(params.cfg),
    message_provenance: "assistant",
    message_created_at: fetchedMessage.timestamp ?? undefined,
  };

  await queueDiscordReactionFeedbackRecord(capturePath, record, params.logger);
}

async function queueDiscordReactionFeedbackRecord(
  filePath: string,
  record: DiscordReactionCaptureRecord,
  logger?: DiscordListenerLogger,
): Promise<void> {
  const previous = DISCORD_REACTION_CAPTURE_QUEUE.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await appendDiscordReactionFeedbackRecord(filePath, record);
    });
  DISCORD_REACTION_CAPTURE_QUEUE.set(filePath, next);
  try {
    await next;
  } catch (err) {
    logger?.error?.(`discord reaction capture failed: ${String(err)}`);
  } finally {
    if (DISCORD_REACTION_CAPTURE_QUEUE.get(filePath) === next) {
      DISCORD_REACTION_CAPTURE_QUEUE.delete(filePath);
    }
  }
}

async function appendDiscordReactionFeedbackRecord(
  filePath: string,
  record: DiscordReactionCaptureRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
