import { setTimeout as delay } from "node:timers/promises";
import type { TelegramBotInfo } from "./bot-info.js";

export const telegramBotInfoForTest = {
  id: 9_876_543_210,
  is_bot: true,
  first_name: "OpenClaw",
  username: "openclaw_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  can_manage_bots: false,
  supports_inline_queries: false,
  supports_join_request_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} satisfies TelegramBotInfo;

export type TelegramMentionPolicyForTest = {
  mode: "allow" | "deny";
  allowIn?: string[];
  denyIn?: string[];
};

export function createChannelPostContext(params: {
  messageId: number;
  date: number;
  title?: string;
  caption?: string;
  text?: string;
  mediaGroupId?: string;
  photoFileId?: string;
  getFileResult?: Record<string, unknown>;
}) {
  const photoFileId = params.photoFileId;
  return {
    channelPost: {
      chat: { id: -100777111222, type: "channel", title: params.title ?? "Wake Channel" },
      message_id: params.messageId,
      date: params.date,
      ...(params.caption ? { caption: params.caption } : {}),
      ...(params.text ? { text: params.text } : {}),
      ...(params.mediaGroupId ? { media_group_id: params.mediaGroupId } : {}),
      ...(photoFileId ? { photo: [{ file_id: photoFileId }] } : {}),
    },
    me: { username: "openclaw_bot" },
    getFile: async () =>
      params.getFileResult ?? (photoFileId ? { file_path: `photos/${photoFileId}.jpg` } : {}),
  };
}

export type TelegramIngestGroupForTest = {
  requireMention: boolean;
  ingest?: boolean;
  topics?: Record<string, { ingest: boolean }>;
};

export function telegramIngestGroupForTest(
  ingest?: boolean,
  topics?: Record<string, { ingest: boolean }>,
): TelegramIngestGroupForTest {
  return {
    requireMention: true,
    ...(ingest === undefined ? {} : { ingest }),
    ...(topics ? { topics } : {}),
  };
}

export type TelegramMentionCaseForTest = [
  string,
  TelegramMentionPolicyForTest,
  TelegramMentionPolicyForTest | undefined,
  number | undefined,
  boolean,
  number,
];

export async function waitForTelegramMockCalls(
  mock: { mock: { calls: unknown[] } },
  count: number,
) {
  for (let index = 0; index < 80; index++) {
    if (mock.mock.calls.length >= count) {
      return;
    }
    await delay(25);
  }
}
