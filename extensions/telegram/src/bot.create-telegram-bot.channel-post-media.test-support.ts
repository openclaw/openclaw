import { vi } from "vitest";

export function createImageFetchSpy(params?: { body?: Uint8Array; contentType?: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(Buffer.from(params?.body ?? [0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": params?.contentType ?? "image/png" },
      }),
  );
}

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
      params.getFileResult ?? (photoFileId ? { file_path: `photos/${photoFileId}.jpg` } : {}),
  };
}

export function createTelegramPrivateMediaContext(params: {
  messageId: number;
  fileId: string;
  fileName?: string;
  update?: { update_id: number };
  getFile?: () => Promise<{ file_path: string }>;
}) {
  return {
    ...(params.update ? { update: params.update } : {}),
    message: {
      chat: { id: 1234, type: "private" },
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
    getFile: params.getFile ?? (async () => ({ file_path: `documents/${params.fileId}` })),
  };
}
