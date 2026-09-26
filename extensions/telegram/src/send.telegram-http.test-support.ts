import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { deliverReplies } from "./bot/delivery.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

export function resolveTelegramTestUpload(fields: Record<string, unknown>, key: string): File {
  const reference = fields[key];
  if (typeof reference !== "string" || !reference.startsWith("attach://")) {
    throw new Error(`Telegram ${key} did not reference a multipart upload`);
  }
  const upload = fields[reference.slice("attach://".length)];
  if (!(upload instanceof File)) {
    throw new Error(`Telegram ${key} referenced a missing multipart upload`);
  }
  return upload;
}

export function useTelegramHttpFixture() {
  let server: Server;
  let bot: Bot;
  let mediaDir: string;
  let photoPath: string;
  let env: ReturnType<typeof captureEnv> | undefined;
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; fields: Record<string, unknown> }> = [];
  const events: string[] = [];
  const endpoints: string[] = [];
  const rejections: Array<
    | string
    | { error_code: number; description: string; parameters?: Record<string, number> }
    | { resetConnection: true }
  > = [];
  let responseFor: ((method: string, fields: Record<string, unknown>) => unknown) | undefined;
  let requestHold:
    | {
        arrived: ReturnType<typeof createDeferred<void>>;
        release: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  const cfg = {
    channels: { telegram: { botToken: "123456:telegram-send-http-fixture", apiRoot: "" } },
  };
  const buttons = [[{ text: "Continue", callback_data: "continue" }]];
  const telegramOutbound = createTelegramOutboundAdapter();
  const runtime = {
    log() {},
    error() {},
    exit(): never {
      throw new Error("unexpected exit");
    },
  };

  beforeAll(async () => {
    const proxyKeys = [
      "OPENCLAW_DEBUG_PROXY_ENABLED",
      "OPENCLAW_DEBUG_PROXY_URL",
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "OPENCLAW_PROXY_URL",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_PROXY_CA_FILE",
    ];
    env = captureEnv([...proxyKeys, "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER"]);
    // Loopback transport proof must not inherit a host proxy or lose its direct fallback.
    for (const key of proxyKeys) {
      delete process.env[key];
    }
    // Native fetch may have captured the proxy at process startup; keep local requests local.
    process.env.NO_PROXY = "127.0.0.1,localhost,::1";
    process.env.no_proxy = process.env.NO_PROXY;
    process.env.OPENCLAW_TELEGRAM_DNS_RESULT_ORDER = "ipv4first";
    resetTelegramClientOptionsCacheForTests();
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-physical-send-"));
    photoPath = path.join(mediaDir, "pixel.png");
    await fs.writeFile(
      photoPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await fs.copyFile(photoPath, path.join(mediaDir, "second.png"));
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const respond = async () => {
        const body = Buffer.concat(chunks);
        const contentType = request.headers["content-type"] ?? "application/json";
        const fields = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(body, { headers: { "content-type": contentType } }).formData(),
            )
          : (JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        const method = request.url?.split("/").at(-1) ?? "";
        requests.push({ method, fields });
        endpoints.push(request.url ?? "");
        events.push("http");
        const held = requestHold;
        requestHold = undefined;
        if (held) {
          held.arrived.resolve();
          await held.release.promise;
        }
        response.setHeader("content-type", "application/json");
        const rejection = rejections.shift();
        if (rejection) {
          if (typeof rejection === "object" && "resetConnection" in rejection) {
            response.destroy();
            return;
          }
          const error =
            typeof rejection === "string" ? { error_code: 400, description: rejection } : rejection;
          response.statusCode = error.error_code;
          response.end(JSON.stringify({ ok: false, ...error }));
          return;
        }
        const custom = responseFor?.(method, fields);
        if (custom !== undefined) {
          response.end(JSON.stringify({ ok: true, result: custom }));
          return;
        }
        const message = {
          message_id: method.startsWith("edit") ? Number(fields.message_id) : requests.length,
          date: 1_700_000_000,
          chat:
            Number(fields.chat_id ?? 123) < 0
              ? { id: Number(fields.chat_id), type: "supergroup", title: "Fixture group" }
              : { id: Number(fields.chat_id ?? 123), type: "private", first_name: "Fixture" },
          text: fields.text,
          caption: fields.caption,
          ...(fields.message_thread_id
            ? { message_thread_id: Number(fields.message_thread_id) }
            : {}),
        };
        const result =
          method === "pinChatMessage" ||
          method === "deleteMessage" ||
          method === "setMessageReaction" ||
          method === "sendChatAction" ||
          method === "answerCallbackQuery" ||
          method === "editForumTopic" ||
          method === "setMyCommands" ||
          method === "deleteMyCommands"
            ? true
            : method === "getChat"
              ? message.chat
              : method === "sendMediaGroup"
                ? (JSON.parse(String(fields.media)) as unknown[]).map((_, index) =>
                    Object.assign({}, message, { message_id: 1001 + index }),
                  )
                : method === "sendPoll"
                  ? {
                      ...message,
                      poll: {
                        id: "http-poll",
                        question: fields.question,
                        options: [
                          { text: "Yes", voter_count: 0 },
                          { text: "No", voter_count: 0 },
                        ],
                        total_voter_count: 0,
                        is_closed: false,
                        is_anonymous: fields.is_anonymous ?? true,
                        type: "regular",
                        allows_multiple_answers: false,
                      },
                    }
                  : message;
        response.end(JSON.stringify({ ok: true, result }));
      };
      request.on("end", () => {
        void respond().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cfg.channels.telegram.apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bot = new Bot(cfg.channels.telegram.botToken, {
      client: { apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    });
  });

  beforeEach(() => {
    requests.length = 0;
    events.length = 0;
    endpoints.length = 0;
    rejections.length = 0;
    responseFor = undefined;
  });

  afterAll(async () => {
    try {
      resetTelegramClientOptionsCacheForTests();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(mediaDir, { recursive: true, force: true });
    } finally {
      env?.restore();
    }
  });

  async function sendThrough(
    entry: "direct" | "public",
    text: string,
    dispatch: () => Promise<void>,
    mediaUrl?: string,
    rich = false,
    assertPlatformSendAuthorized?: () => void,
    options: {
      textMode?: "html" | "markdown";
      threadId?: number;
      linkPreview?: boolean;
      firstReply?: boolean;
      textLimit?: number;
    } = {},
  ) {
    if (entry === "public") {
      return sendMessageTelegram("123", text, {
        cfg: {
          channels: {
            telegram: {
              ...cfg.channels.telegram,
              richMessages: rich,
              linkPreview: options.linkPreview,
            },
          },
        },
        api: bot.api,
        textMode: options.textMode ?? (rich ? undefined : "html"),
        replyToMessageId: 7,
        quoteText: "quote",
        ...(options.firstReply ? { replyToIdSource: "implicit", replyToMode: "first" } : {}),
        messageThreadId: options.threadId,
        onPlatformSendDispatch: dispatch,
        assertPlatformSendAuthorized,
        ...(mediaUrl ? { mediaUrl, mediaLocalRoots: [mediaDir], buttons } : {}),
        ...(rich ? { buttons } : {}),
      });
    }
    return deliverReplies({
      cfg,
      bot,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      runtime,
      replies: [
        {
          text,
          replyToId: "7",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrl || rich ? { channelData: { telegram: { buttons } } } : {}),
        },
      ],
      mediaLocalRoots: [mediaDir],
      replyToMode: options.firstReply ? "first" : "all",
      textLimit: options.textLimit ?? 4000,
      ...(options.threadId ? { thread: { scope: "forum", id: options.threadId } } : {}),
      linkPreview: options.linkPreview,
      replyQuoteMessageId: 7,
      replyQuoteText: "quote",
      textMode:
        options.textMode === "markdown"
          ? undefined
          : (options.textMode ?? (rich ? undefined : "html")),
      richMessages: rich,
      onPlatformSendDispatch: dispatch,
      assertPlatformSendAuthorized,
    });
  }

  async function pinThroughAdapter(
    token: string,
    messageId: number,
    assertDirectAdapterHandoff?: () => void,
  ) {
    await telegramOutbound.pinDeliveredMessage!({
      cfg: {
        channels: {
          telegram: {
            botToken: token,
            apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
        },
      },
      target: { channel: "telegram", to: "123", accountId: "default" },
      messageId: String(messageId),
      pin: { enabled: true },
      ...(assertDirectAdapterHandoff ? { assertDirectAdapterHandoff } : {}),
    });
  }

  return {
    cfg,
    requests,
    events,
    endpoints,
    rejections,
    buttons,
    runtime,
    telegramOutbound,
    sendThrough,
    pinThroughAdapter,
    set responseFor(value: typeof responseFor) {
      responseFor = value;
    },
    get bot() {
      return bot;
    },
    get mediaDir() {
      return mediaDir;
    },
    get photoPath() {
      return photoPath;
    },
    get requestHold() {
      return requestHold;
    },
    set requestHold(value: typeof requestHold) {
      requestHold = value;
    },
  };
}
