import { readFile } from "node:fs/promises";
import { Context } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type * as TelegramMediaRuntime from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  apiResponses,
  chat,
  createBot,
  from,
  harness,
  nextTelegramTestMessageId,
  photo,
  publishTelegramTestConfig,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { mediaDownload, telegramMediaPng } from "./bot.media.native.test-utils.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import { cacheSticker, getCachedSticker } from "./sticker-cache.js";
import { resolveStickerVisionSupportRuntime } from "./sticker-vision.runtime.js";

vi.mock("./sticker-vision.runtime.js", { spy: true });

const base = { date: 1736380800, from, chat };
function mediaUpdate<T extends object>(media: T) {
  const id = nextTelegramTestMessageId();
  return { update_id: id, message: { ...base, message_id: id, ...media } };
}

const fileResponse = (file_path: string) =>
  apiResponses.set("getFile", { ok: true, result: { file_path } });
const reply = (index = 0) => harness.replySpy.mock.calls[index]![0];
const expectOneDownload = () => {
  expect(mediaDownload).toHaveBeenCalledOnce();
  expect(apiCalls.mock.calls.filter(([method]) => method === "getFile")).toHaveLength(1);
};
type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
const mediaConfig = (botToken: string, extra: Partial<TelegramConfig> = {}): OpenClawConfig => ({
  channels: { telegram: { botToken, dmPolicy: "open", allowFrom: ["*"], ...extra } },
});

describe("registered Telegram media", () => {
  it.each([
    { caption: "Animation caption", companionDocument: true },
    { caption: "Animation caption", companionDocument: false },
    { caption: undefined, companionDocument: true },
    { caption: undefined, companionDocument: false },
  ])("downloads animation as video: %j", async ({ caption, companionDocument }) => {
    const animationBytes = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
    mediaDownload.mockImplementation(({ maxBytes, originalFilename }) =>
      saveMediaBuffer(animationBytes, "video/mp4", "inbound", maxBytes, originalFilename),
    );
    const bot = await createBot(false);
    const animation = {
      file_id: "animation-file",
      file_unique_id: "animation-unique",
      width: 32,
      height: 32,
      duration: 1,
      file_name: "animation.mp4",
      mime_type: "video/mp4",
    };
    await bot.handleUpdate(
      mediaUpdate({
        animation,
        ...(companionDocument ? { document: animation } : {}),
        ...(caption ? { caption } : {}),
      }),
    );
    expect(harness.replySpy).toHaveBeenCalledOnce();
    expect(reply()).toMatchObject({
      BodyForAgent: caption ?? "",
      media: [{ kind: "video", contentType: "video/mp4", fileName: "animation.mp4" }],
    });
    expect(await readFile(reply().media![0]!.path!)).toEqual(animationBytes);
    expectOneDownload();
  });

  it("reuses a stored description, refreshes its file identity, and skips unsupported sticker bytes", async () => {
    vi.mocked(resolveStickerVisionSupportRuntime).mockResolvedValue(false);
    await cacheSticker({
      fileId: "old-file",
      fileUniqueId: "stable-sticker",
      emoji: "old",
      setName: "OldSet",
      description: "A waving sticker",
      cachedAt: "2026-01-20T10:00:00.000Z",
    });
    const bot = await createBot(false);
    const sticker = {
      file_id: "current-file",
      file_unique_id: "stable-sticker",
      type: "regular" as const,
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
      emoji: "new",
      set_name: "NewSet",
    };
    await bot.handleUpdate(mediaUpdate({ sticker }));
    expect(await getCachedSticker("stable-sticker")).toMatchObject({
      fileId: "current-file",
      emoji: "new",
      setName: "NewSet",
      description: "A waving sticker",
    });
    expect(reply()).toMatchObject({
      BodyForAgent: expect.stringContaining("A waving sticker"),
      SkipStickerMediaUnderstanding: true,
    });
    expect(await readFile(reply().media![0]!.path!)).toEqual(telegramMediaPng);
    for (const [index, variant] of [
      { is_animated: true, is_video: false },
      { is_animated: false, is_video: true },
    ].entries()) {
      await bot.handleUpdate(
        mediaUpdate({
          sticker: {
            ...sticker,
            ...variant,
            file_unique_id: `unsupported-${index}`,
            emoji: undefined,
          },
        }),
      );
      const unavailable = reply(index + 1);
      expect(unavailable.BodyForAgent).toBe("<media:sticker>");
      expect(unavailable.media!.every((media) => media.path === undefined)).toBe(true);
    }
    expect(harness.replySpy).toHaveBeenCalledTimes(3);
    expectOneDownload();
  });

  it("reads a trusted Bot API host mount but refuses a readable file outside that root", async () => {
    const root = harness.state.statePath("trusted-media");
    const token = "123456:local-media";
    await harness.state.writeText(
      `trusted-media/${token}/documents/file.txt`,
      "trusted document bytes",
    );
    const outside = await harness.state.writeText("outside.txt", "must not enter the model");
    const bot = await createBot(
      false,
      true,
      mediaConfig(token, {
        trustedLocalFileRoots: [root],
        streaming: { mode: "off" },
      }),
    );
    fileResponse(`/var/lib/telegram-bot-api/${token}/documents/file.txt`);
    const document = {
      file_id: "local-document",
      file_unique_id: "local-document-unique",
      file_name: "file.txt",
      mime_type: "text/plain",
    };
    await bot.handleUpdate(mediaUpdate({ document }));
    expect(await readFile(reply().media![0]!.path!, "utf8")).toBe("trusted document bytes");
    fileResponse(outside);
    await bot.handleUpdate(mediaUpdate({ document }));
    expect(reply(1)).toMatchObject({
      BodyForAgent: "[media unavailable: download failed]",
      media: [{ kind: "document" }],
    });
    const { path: mediaPath, url } = reply(1).media![0]!;
    expect({ mediaPath, url }).toEqual({ mediaPath: undefined, url: undefined });
    expect(mediaDownload).not.toHaveBeenCalled();
  });
  it("downloads actual bytes through the provided transport and configured Bot API prefix", async () => {
    const token = "123456:media-transport";
    const cfg = mediaConfig(token);
    publishTelegramTestConfig(cfg);
    const apiRoot = `${cfg.channels!.telegram!.apiRoot}/custom-bot-api`;
    cfg.channels!.telegram!.apiRoot = apiRoot;
    const bot = await createBot(false, true, cfg);
    fileResponse("photos/transport.png");
    const actual = await vi.importActual<typeof TelegramMediaRuntime>(
      "openclaw/plugin-sdk/media-runtime",
    );
    mediaDownload.mockImplementationOnce(actual.saveRemoteMedia);
    const sourceFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(telegramMediaPng, {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("global fetch must not acquire media"),
    );
    const ctx = new Context(mediaUpdate({ photo }), bot.api, bot.botInfo);
    if (!ctx.has("message")) {
      throw new Error("Expected Telegram media message");
    }
    const media = await resolveMedia({
      ctx,
      token,
      apiRoot,
      maxBytes: 1024,
      transport: { fetch: sourceFetch, sourceFetch, close: async () => {} },
    });
    expect(
      sourceFetch.mock.calls.map(([url]) =>
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      ),
    ).toEqual([`${apiRoot}/file/bot${token}/photos/transport.png`]);
    expect(await readFile(media!.path)).toEqual(telegramMediaPng);
    expect(media).toMatchObject({ contentType: "image/png", kind: "image" });
  });
});
