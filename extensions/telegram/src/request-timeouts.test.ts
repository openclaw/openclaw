// Telegram tests cover request timeouts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  getTelegramUploadBytes,
  recordTelegramUploadBytes,
  resolveTelegramRequestTimeoutMs,
  telegramUploadTimeoutTransformer,
} from "./request-timeouts.js";

const MIB = 1024 * 1024;

describe("resolveTelegramRequestTimeoutMs", () => {
  it("keeps table guards for uploads that fit inside them", () => {
    expect(resolveTelegramRequestTimeoutMs("sendphoto", undefined, MIB)).toBe(30_000);
    // 30 MiB moves in 15s at 2 MiB/s; with the 15s margin that is the table value.
    expect(resolveTelegramRequestTimeoutMs("senddocument", undefined, 30 * MIB)).toBe(30_000);
  });

  it("adds transfer time for uploads that outgrow their table guard", () => {
    expect(resolveTelegramRequestTimeoutMs("senddocument", undefined, 30 * MIB + 1)).toBe(31_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 100 * MIB)).toBe(65_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 900 * MIB)).toBe(465_000);
    expect(resolveTelegramRequestTimeoutMs("sendmediagroup", undefined, 200 * MIB)).toBe(115_000);
  });

  it("caps upload guards at 30 minutes", () => {
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 8 * 1024 * MIB)).toBe(1_800_000);
  });

  it("ignores upload size for getUpdates and unusable sizes", () => {
    expect(resolveTelegramRequestTimeoutMs("getupdates", undefined, 100 * MIB)).toBe(45_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, Number.NaN)).toBe(30_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, -1)).toBe(30_000);
  });
});

describe("telegramUploadTimeoutTransformer", () => {
  it("exposes recorded upload bytes only to the request that carries the file", async () => {
    const transform = telegramUploadTimeoutTransformer as unknown as (
      prev: () => Promise<unknown>,
      method: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>;
    const video = recordTelegramUploadBytes({}, 100 * MIB);
    const photo = recordTelegramUploadBytes({}, MIB);
    const seen: Array<number | undefined> = [];
    const prev = async () => {
      seen.push(getTelegramUploadBytes());
      return { ok: true, result: true };
    };

    await transform(prev, "sendVideo", { chat_id: 1, video });
    await transform(prev, "sendMediaGroup", {
      chat_id: 1,
      media: [
        { type: "video", media: video },
        { type: "photo", media: photo },
      ],
    });
    await transform(prev, "sendMessage", { chat_id: 1, text: "done" });

    expect(seen).toEqual([100 * MIB, 101 * MIB, undefined]);
    expect(getTelegramUploadBytes()).toBeUndefined();
  });
});
