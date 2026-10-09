import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Context } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type * as TelegramMediaRuntime from "openclaw/plugin-sdk/media-runtime";
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

describe("registered Telegram stickers and local media", () => {
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
    const stickerMessageId = nextTelegramTestMessageId();
    await bot.handleUpdate({
      update_id: stickerMessageId,
      message: { ...base, message_id: stickerMessageId, sticker },
    });
    expect(await getCachedSticker("stable-sticker")).toMatchObject({
      fileId: "current-file",
      emoji: "new",
      setName: "NewSet",
      description: "A waving sticker",
    });
    const context = harness.replySpy.mock.calls[0]![0];
    expect(context.BodyForAgent).toContain("A waving sticker");
    expect(context.SkipStickerMediaUnderstanding).toBe(true);
    expect(await readFile(context.media![0]!.path!)).toEqual(telegramMediaPng);
    for (const [index, variant] of [
      { is_animated: true, is_video: false },
      { is_animated: false, is_video: true },
    ].entries()) {
      const messageId = nextTelegramTestMessageId();
      await bot.handleUpdate({
        update_id: messageId,
        message: {
          ...base,
          message_id: messageId,
          sticker: {
            ...sticker,
            ...variant,
            file_unique_id: `unsupported-${index}`,
            emoji: undefined,
          },
        },
      });
      const unavailable = harness.replySpy.mock.calls[index + 1]![0];
      expect(unavailable.BodyForAgent).toBe("<media:sticker>");
      expect(unavailable.media!.every((media) => media.path === undefined)).toBe(true);
    }
    expect(harness.replySpy).toHaveBeenCalledTimes(3);
    expect(mediaDownload).toHaveBeenCalledOnce();
    expect(apiCalls.mock.calls.filter(([method]) => method === "getFile")).toHaveLength(1);
  });

  it("reads a trusted Bot API host mount but refuses a readable file outside that root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-native-local-media-"));
    const outside = `${root}-outside.txt`;
    const token = "123456:local-media";
    try {
      await mkdir(path.join(root, token, "documents"), { recursive: true });
      await writeFile(path.join(root, token, "documents", "file.txt"), "trusted document bytes");
      await writeFile(outside, "must not enter the model");
      const bot = await createBot(false, true, {
        channels: {
          telegram: {
            botToken: token,
            dmPolicy: "open",
            allowFrom: ["*"],
            trustedLocalFileRoots: [root],
            streaming: { mode: "off" },
          },
        },
      });
      apiResponses.set("getFile", {
        ok: true,
        result: { file_path: `/var/lib/telegram-bot-api/${token}/documents/file.txt` },
      });
      const document = {
        file_id: "local-document",
        file_unique_id: "local-document-unique",
        file_name: "file.txt",
        mime_type: "text/plain",
      };
      const allowedId = nextTelegramTestMessageId();
      await bot.handleUpdate({
        update_id: allowedId,
        message: { ...base, message_id: allowedId, document },
      });
      expect(await readFile(harness.replySpy.mock.calls[0]![0].media![0]!.path!, "utf8")).toBe(
        "trusted document bytes",
      );
      apiResponses.set("getFile", { ok: true, result: { file_path: outside } });
      const deniedId = nextTelegramTestMessageId();
      await bot.handleUpdate({
        update_id: deniedId,
        message: { ...base, message_id: deniedId, document },
      });
      expect(harness.replySpy.mock.calls[1]![0]).toMatchObject({
        BodyForAgent: "[media unavailable: download failed]",
        media: [{ kind: "document" }],
      });
      expect(harness.replySpy.mock.calls[1]![0].media?.[0]?.path).toBeUndefined();
      expect(harness.replySpy.mock.calls[1]![0].media?.[0]?.url).toBeUndefined();
      expect(mediaDownload).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });
});

describe("registered Telegram media transport", () => {
  it("downloads actual bytes through the provided transport and configured Bot API prefix", async () => {
    const token = "123456:media-transport";
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: token, dmPolicy: "open", allowFrom: ["*"] } },
    };
    publishTelegramTestConfig(cfg);
    const apiRoot = `${cfg.channels!.telegram!.apiRoot}/custom-bot-api`;
    cfg.channels!.telegram!.apiRoot = apiRoot;
    const bot = await createBot(false, true, cfg);
    apiResponses.set("getFile", { ok: true, result: { file_path: "photos/transport.png" } });
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
    const messageId = nextTelegramTestMessageId();
    const ctx = new Context(
      { update_id: messageId, message: { ...base, chat, message_id: messageId, photo } },
      bot.api,
      bot.botInfo,
    );
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
