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

function fileRef(fileId: string, filePath?: string) {
  return {
    file_id: fileId,
    file_unique_id: `unique-${fileId}`,
    ...(filePath ? { file_path: filePath } : {}),
  };
}

const photoRef = (fileId: string) => [{ ...fileRef(fileId), width: 1, height: 1 }];

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
      ...(photoFileId ? { photo: photoRef(photoFileId) } : {}),
    },
    me: { username: "openclaw_bot" },
    getFile: async () =>
      params.getFileResult ??
      (photoFileId ? fileRef(photoFileId, `photos/${photoFileId}.jpg`) : {}),
  };
}

export type TelegramIngestGroupForTest = {
  requireMention: boolean;
  ingest?: boolean;
  topics?: Record<string, { ingest: boolean }>;
};

export const telegramIngestGroupForTest = (
  ingest?: boolean,
  topics?: Record<string, { ingest: boolean }>,
): TelegramIngestGroupForTest => ({
  requireMention: true,
  ...(ingest === undefined ? {} : { ingest }),
  ...(topics ? { topics } : {}),
});

export async function waitForTelegramMockCalls(
  mock: { mock: { calls: unknown[] } },
  count: number,
) {
  for (let index = 0; index < 80 && mock.mock.calls.length < count; index++) {
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
    secondGetFileResult?: Record<string, unknown>;
  },
) {
  await Promise.all(
    [0, 1].map((index) =>
      handler(
        createChannelPostContext({
          messageId: index ? params.secondMessageId : params.firstMessageId,
          photoFileId: `p${index + 1}`,
          caption: index ? undefined : params.caption,
          getFileResult: index ? params.secondGetFileResult : undefined,
          date: 1736380800 + index,
          mediaGroupId: params.mediaGroupId,
        }),
      ),
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
        ? { document: { ...fileRef(params.fileId), file_name: params.fileName } }
        : { photo: photoRef(params.fileId) }),
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { username: "openclaw_bot" },
    getFile: params.getFile ?? (async () => fileRef(params.fileId, `documents/${params.fileId}`)),
  };
}

type RetryContextParams = {
  messageId?: number;
  updateId?: number;
  from?: Record<string, unknown>;
  message?: Record<string, unknown>;
  downloadable?: boolean;
};

function middlewareContext(updateId: number | undefined, downloadable = false) {
  return {
    ...(updateId === undefined ? {} : { update: { update_id: updateId } }),
    me: { username: "openclaw_bot" },
    getFile: async () => (downloadable ? { download: async () => new Uint8Array() } : {}),
  };
}

export function makePrivateTextContext(
  params: RetryContextParams & {
    text: string;
    date?: number;
    chatId?: number;
  },
): TelegramMiddlewareTestContext {
  return {
    ...middlewareContext(params.updateId, params.downloadable),
    message: {
      chat: { id: params.chatId ?? 7, type: "private" },
      text: params.text,
      date: params.date ?? 1736380800,
      ...(params.messageId === undefined ? {} : { message_id: params.messageId }),
      from: params.from ?? { id: 42, first_name: "Ada" },
      ...params.message,
    },
  };
}

export function makeCallbackRetryContext(
  params: RetryContextParams & {
    id: string;
    data: string;
    messageId: number;
    text?: string;
  },
): TelegramMiddlewareTestContext {
  return {
    ...middlewareContext(params.updateId, params.downloadable !== false),
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
  };
}
