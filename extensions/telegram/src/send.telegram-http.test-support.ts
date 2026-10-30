import fs from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { Bot } from "grammy";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
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

// Lifecycle hooks initialize these before any case uses the fixture.
class TelegramHttpState {
  bot!: Bot;
  mediaDir!: string;
  photoPath!: string;
  responseFor?: (method: string, fields: Record<string, unknown>) => unknown;
  handleRequest?: (
    method: string,
    fields: Record<string, unknown>,
    response: ServerResponse,
  ) => boolean;
  requestHold?: {
    arrived: ReturnType<typeof createDeferred<void>>;
    release: ReturnType<typeof createDeferred<void>>;
  };
  sockets = new Set<Socket>();
  requestSockets = new Map<string, Socket>();
  requests: Array<{ method: string; fields: Record<string, unknown> }> = [];
  events: string[] = [];
  endpoints: string[] = [];
  rejections: Array<
    | string
    | { error_code: number; description: string; parameters?: Record<string, number> }
    | { resetConnection: true }
  > = [];
  cfg = {
    channels: { telegram: { botToken: "123456:telegram-send-http-fixture", apiRoot: "" } },
  };
  buttons = [[{ text: "Continue", callback_data: "continue" }]];
  telegramOutbound = createTelegramOutboundAdapter();
  runtime = {
    log() {},
    error() {},
    exit(): never {
      throw new Error("unexpected exit");
    },
  };
}

export function useTelegramHttpFixture() {
  let server: Server;
  const state = new TelegramHttpState();
  let env: ReturnType<typeof captureEnv> | undefined;
  const { cfg, requests, requestSockets, rejections, buttons, runtime } = state;
  const config = (overrides: TelegramAccountConfig) => ({
    channels: { telegram: { ...cfg.channels.telegram, ...overrides } },
  });

  beforeAll(async () => {
    const proxyKeys = [
      "OPENCLAW_DEBUG_PROXY_ENABLED",
      "OPENCLAW_DEBUG_PROXY_URL",
      ...["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].flatMap((key) => [
        key,
        key.toLowerCase(),
      ]),
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
    state.mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-physical-send-"));
    state.photoPath = path.join(state.mediaDir, "pixel.png");
    await fs.writeFile(
      state.photoPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await fs.copyFile(state.photoPath, path.join(state.mediaDir, "second.png"));
    server = createServer((request, response) => {
      const respond = async () => {
        const body = await buffer(request);
        const contentType = request.headers["content-type"] ?? "application/json";
        const fields = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(body, { headers: { "content-type": contentType } }).formData(),
            )
          : (JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        const method = request.url?.split("/").at(-1) ?? "";
        if (method === "sendMessage" || method === "editMessageText") {
          requestSockets.set(request.url!.slice(0, request.url!.lastIndexOf("/")), request.socket);
        }
        requests.push({ method, fields });
        state.endpoints.push(request.url ?? "");
        state.events.push("http");
        const held = state.requestHold;
        state.requestHold = undefined;
        if (held) {
          held.arrived.resolve();
          await held.release.promise;
        }
        response.setHeader("content-type", "application/json");
        if (state.handleRequest?.(method, fields, response)) {
          return;
        }
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
        const custom = state.responseFor?.(method, fields);
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
      void respond().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    // Application-clock jumps must not evict a real HTTP request's peer socket.
    server.keepAliveTimeout = 0;
    server.on("connection", (socket) => {
      state.sockets.add(socket);
      socket.on("close", () => state.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cfg.channels.telegram.apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.bot = new Bot(cfg.channels.telegram.botToken, {
      client: { apiRoot: cfg.channels.telegram.apiRoot },
    });
  });

  beforeEach(() => {
    requestSockets.clear();
    requests.length = 0;
    state.events.length = 0;
    state.endpoints.length = 0;
    rejections.length = 0;
    state.responseFor = undefined;
    state.handleRequest = undefined;
  });

  afterAll(async () => {
    try {
      resetTelegramClientOptionsCacheForTests();
      for (const socket of state.sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(state.mediaDir, { recursive: true, force: true });
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
    const textMode = options.textMode ?? (rich ? undefined : "html");
    const replyButtons = mediaUrl || rich ? { buttons } : {};
    const authorization = { onPlatformSendDispatch: dispatch, assertPlatformSendAuthorized };
    if (entry === "public") {
      return sendMessageTelegram("123", text, {
        cfg: config({ richMessages: rich, linkPreview: options.linkPreview }),
        api: state.bot.api,
        textMode,
        replyToMessageId: 7,
        quoteText: "quote",
        ...(options.firstReply ? { replyToIdSource: "implicit", replyToMode: "first" } : {}),
        messageThreadId: options.threadId,
        ...authorization,
        ...(mediaUrl ? { mediaUrl, mediaLocalRoots: [state.mediaDir] } : {}),
        ...replyButtons,
      });
    }
    return deliverReplies({
      cfg,
      bot: state.bot,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      runtime,
      replies: [
        {
          text,
          replyToId: "7",
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrl || rich ? { channelData: { telegram: replyButtons } } : {}),
        },
      ],
      mediaLocalRoots: [state.mediaDir],
      replyToMode: options.firstReply ? "first" : "all",
      textLimit: options.textLimit ?? 4000,
      ...(options.threadId ? { thread: { scope: "forum", id: options.threadId } } : {}),
      linkPreview: options.linkPreview,
      replyQuoteMessageId: 7,
      replyQuoteText: "quote",
      textMode: textMode === "markdown" ? undefined : textMode,
      richMessages: rich,
      ...authorization,
    });
  }

  async function pinThroughAdapter(
    token: string,
    messageId: number,
    assertDirectAdapterHandoff?: () => void,
  ) {
    await state.telegramOutbound.pinDeliveredMessage!({
      cfg: config({ botToken: token }),
      target: { channel: "telegram", to: "123", accountId: "default" },
      messageId: String(messageId),
      pin: { enabled: true },
      ...(assertDirectAdapterHandoff ? { assertDirectAdapterHandoff } : {}),
    });
  }

  return Object.assign(state, { sendThrough, pinThroughAdapter });
}
