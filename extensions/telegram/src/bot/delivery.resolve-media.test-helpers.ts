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
  const msg: Record<string, unknown> = {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
  };
  if (mediaField === "voice") {
    msg.voice = {
      file_id: "v1",
      duration: 5,
      file_unique_id: "u1",
      ...(opts?.mime_type && { mime_type: opts.mime_type }),
    };
  }
  if (mediaField === "audio") {
    msg.audio = {
      file_id: "a1",
      duration: 5,
      file_unique_id: "u2",
      ...(opts?.file_name && { file_name: opts.file_name }),
      ...(opts?.mime_type && { mime_type: opts.mime_type }),
    };
  }
  if (mediaField === "photo") {
    msg.photo = [{ file_id: "p1", width: 100, height: 100 }];
  }
  if (mediaField === "video") {
    msg.video = {
      file_id: "vid1",
      duration: 10,
      file_unique_id: "u3",
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "document") {
    msg.document = {
      file_id: "d1",
      file_unique_id: "u4",
      ...(opts?.file_name && { file_name: opts.file_name }),
      ...(opts?.mime_type && { mime_type: opts.mime_type }),
    };
  }
  if (mediaField === "animation") {
    msg.animation = {
      file_id: "an1",
      duration: 3,
      file_unique_id: "u5",
      width: 200,
      height: 200,
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "sticker") {
    msg.sticker = {
      file_id: "stk1",
      file_unique_id: "ustk1",
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
    };
  }
  return {
    message: msg as unknown as Message,
    me: {
      id: 1,
      is_bot: true,
      first_name: "bot",
      username: "bot",
    } as unknown as TelegramContext["me"],
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

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function expectResolvedMediaFields(
  result: Awaited<ReturnType<typeof resolveMedia>>,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireResolvedMedia(result, label), fields);
}

export async function expectMediaFetchError(
  promise: Promise<unknown>,
  fields: { code: string; messageIncludes: string; name?: string; status?: number },
) {
  try {
    await promise;
  } catch (error) {
    const record = requireRecord(error, "MediaFetchError");
    expect(record.name).toBe(fields.name ?? "MediaFetchError");
    expect(record.code).toBe(fields.code);
    expect(String(record.message)).toContain(fields.messageIncludes);
    if (fields.status !== undefined) {
      expect(record.status).toBe(fields.status);
    }
    return;
  }
  throw new Error("expected MediaFetchError rejection");
}
