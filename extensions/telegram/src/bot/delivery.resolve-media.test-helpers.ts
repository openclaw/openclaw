import type { Message } from "grammy/types";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";
import type { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

const requireRecord = createRequireRecord("record", "expected-label-record");

export function makeCtx(
  mediaField: "voice" | "audio" | "photo" | "video" | "document" | "animation" | "sticker",
  getFile: TelegramContext["getFile"],
  opts?: { file_name?: string; mime_type?: string },
): TelegramContext {
  const filename = opts?.file_name ? { file_name: opts.file_name } : {};
  const mime = opts?.mime_type ? { mime_type: opts.mime_type } : {};
  const media = {
    voice: { file_id: "v1", duration: 5, file_unique_id: "u1", ...mime },
    audio: { file_id: "a1", duration: 5, file_unique_id: "u2", ...filename, ...mime },
    photo: [{ file_id: "p1", width: 100, height: 100 }],
    video: { file_id: "vid1", duration: 10, file_unique_id: "u3", ...filename },
    document: { file_id: "d1", file_unique_id: "u4", ...filename, ...mime },
    animation: {
      file_id: "an1",
      duration: 3,
      file_unique_id: "u5",
      width: 200,
      height: 200,
      ...filename,
    },
    sticker: {
      file_id: "stk1",
      file_unique_id: "ustk1",
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
    },
  };
  return {
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      [mediaField]: media[mediaField],
    } as unknown as Message,
    me: { id: 1, is_bot: true, first_name: "bot", username: "bot" } as TelegramContext["me"],
    getFile,
  };
}

export function requireResolvedMedia(
  result: Awaited<ReturnType<typeof resolveMedia>>,
  label: string,
) {
  if (!result) {
    throw new Error(`expected ${label} media result`);
  }
  return result;
}

export function expectResolvedMediaFields(
  result: Awaited<ReturnType<typeof resolveMedia>>,
  label: string,
  fields: Record<string, unknown>,
) {
  expect(requireResolvedMedia(result, label)).toMatchObject(fields);
}

export async function expectMediaFetchError(
  promise: Promise<unknown>,
  fields: { code: string; messageIncludes: string; name?: string; status?: number },
) {
  try {
    await promise;
  } catch (error) {
    const record = requireRecord(error, "MediaFetchError");
    expect(record).toMatchObject({
      name: fields.name ?? "MediaFetchError",
      code: fields.code,
      ...(fields.status !== undefined ? { status: fields.status } : {}),
    });
    expect(String(record.message)).toContain(fields.messageIncludes);
    return;
  }
  throw new Error("expected MediaFetchError rejection");
}
