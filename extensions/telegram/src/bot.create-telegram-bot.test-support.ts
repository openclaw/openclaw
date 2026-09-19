import { setTimeout as delay } from "node:timers/promises";
import type { File as TelegramFile } from "grammy/types";
import type { TelegramBotInfo } from "./bot-info.js";
import type { TelegramTestContext as TelegramMiddlewareTestContext } from "./bot.test-helpers.js";

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
      ...(photoFileId
        ? {
            photo: [
              {
                file_id: photoFileId,
                file_unique_id: `unique-${photoFileId}`,
                width: 1,
                height: 1,
              },
            ],
          }
        : {}),
    },
    me: { username: "openclaw_bot" },
    getFile: async () =>
      params.getFileResult ??
      (photoFileId
        ? {
            file_id: photoFileId,
            file_unique_id: `unique-${photoFileId}`,
            file_path: `photos/${photoFileId}.jpg`,
          }
        : {}),
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

export async function queueChannelPostAlbum(
  handler: (ctx: Record<string, unknown>) => Promise<void>,
  params: {
    caption: string;
    mediaGroupId: string;
    firstMessageId: number;
    secondMessageId: number;
    firstPhotoFileId?: string;
    secondPhotoFileId?: string;
    secondGetFileResult?: Record<string, unknown>;
  },
) {
  await Promise.all(
    [
      {
        messageId: params.firstMessageId,
        caption: params.caption,
        date: 1736380800,
        photoFileId: params.firstPhotoFileId ?? "p1",
      },
      {
        messageId: params.secondMessageId,
        date: 1736380801,
        photoFileId: params.secondPhotoFileId ?? "p2",
        getFileResult: params.secondGetFileResult,
      },
    ].map((message) =>
      handler(createChannelPostContext({ ...message, mediaGroupId: params.mediaGroupId })),
    ),
  );
}

export function createTelegramPrivateMediaContext(params: {
  messageId: number;
  fileId: string;
  fileName?: string;
  update?: { update_id: number };
  getFile?: () => Promise<TelegramFile>;
}) {
  return {
    ...(params.update ? { update: params.update } : {}),
    message: {
      chat: { id: 1234, type: "private", first_name: "u" },
      message_id: params.messageId,
      date: 1736380800,
      ...(params.fileName
        ? {
            document: {
              file_id: params.fileId,
              file_unique_id: `unique-${params.fileId}`,
              file_name: params.fileName,
            },
          }
        : {
            photo: [
              {
                file_id: params.fileId,
                file_unique_id: `unique-${params.fileId}`,
                width: 1,
                height: 1,
              },
            ],
          }),
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { username: "openclaw_bot" },
    getFile:
      params.getFile ??
      (async () => ({
        file_id: params.fileId,
        file_unique_id: `unique-${params.fileId}`,
        file_path: `documents/${params.fileId}`,
      })),
  };
}

export function makePrivateTextContext(params: {
  text: string;
  messageId?: number;
  updateId?: number;
  date?: number;
  chatId?: number;
  from?: Record<string, unknown>;
  message?: Record<string, unknown>;
  downloadable?: boolean;
}): TelegramMiddlewareTestContext {
  const from = params.from ?? { id: 42, first_name: "Ada" };
  return {
    ...(params.updateId === undefined ? {} : { update: { update_id: params.updateId } }),
    message: {
      chat: { id: params.chatId ?? 7, type: "private" },
      text: params.text,
      date: params.date ?? 1736380800,
      ...(params.messageId === undefined ? {} : { message_id: params.messageId }),
      from,
      ...params.message,
    },
    me: { username: "openclaw_bot" },
    getFile: params.downloadable
      ? async () => ({ download: async () => new Uint8Array() })
      : async () => ({}),
  };
}

export function makeCallbackRetryContext(params: {
  updateId?: number;
  id: string;
  data: string;
  messageId: number;
  text?: string;
  message?: Record<string, unknown>;
  from?: Record<string, unknown>;
  downloadable?: boolean;
}): TelegramMiddlewareTestContext {
  return {
    ...(params.updateId === undefined ? {} : { update: { update_id: params.updateId } }),
    callbackQuery: {
      id: params.id,
      data: params.data,
      from: params.from ?? { id: 9, first_name: "Ada", username: "ada_bot" },
      message: {
        chat: { id: 1234, type: "private" },
        date: 1736380800,
        message_id: params.messageId,
        ...(params.text === undefined ? {} : { text: params.text }),
        ...params.message,
      },
    },
    me: { username: "openclaw_bot" },
    getFile:
      params.downloadable === false
        ? async () => ({})
        : async () => ({ download: async () => new Uint8Array() }),
  };
}
