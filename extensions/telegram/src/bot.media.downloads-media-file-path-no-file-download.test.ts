import { readFile } from "node:fs/promises";
import { Context } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
import type * as TelegramMediaRuntime from "./telegram-media.runtime.js";

const base = { date: 1736380800, from };
describe("registered Telegram media and buffered context", () => {
  it("materializes file_path bytes and reports missing paths as unavailable media", async () => {
    const bot = await createBot(false);
    const firstId = nextTelegramTestMessageId();
    await bot.handleUpdate({
      update_id: firstId,
      message: { ...base, chat, message_id: firstId, photo },
    });
    const materialized = harness.replySpy.mock.calls[0]![0];
    expect(materialized.media).toMatchObject([
      { kind: "image", contentType: "image/png", path: expect.any(String) },
    ]);
    expect(await readFile(materialized.media![0]!.path!)).toEqual(telegramMediaPng);
    expect(materialized.RawBody).toBe("");
    expect(apiCalls.mock.calls.filter(([method]) => method === "getFile")).toHaveLength(1);
    apiResponses.set("getFile", { ok: true, result: {} });
    const secondId = nextTelegramTestMessageId();
    await bot.handleUpdate({
      update_id: secondId,
      message: { ...base, chat, message_id: secondId, photo },
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(2);
    expect(harness.replySpy.mock.calls[1]![0]).toMatchObject({
      BodyForAgent: "[media unavailable: download failed]",
      RawBody: "",
      media: [{ kind: "image" }],
    });
    expect(harness.replySpy.mock.calls[1]![0].media?.[0]?.path).toBeUndefined();
    expect(harness.replySpy.mock.calls[1]![0].media?.[0]?.url).toBeUndefined();
    expect(mediaDownload).toHaveBeenCalledOnce();
  });

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
      "./telegram-media.runtime.js",
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
