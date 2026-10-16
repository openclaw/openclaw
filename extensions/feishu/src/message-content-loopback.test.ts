// Prove Feishu message parsing against the real SDK, auth exchange, and HTTP transport.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuMediaList } from "./bot-content.js";
import { feishuPlugin } from "./channel.js";
import { sendStickerFeishu } from "./media.js";
import { getMessageFeishu } from "./send.js";

const { mockLogVerbose } = vi.hoisted(() => ({ mockLogVerbose: vi.fn() }));
const requireRecord = createRequireRecord("record", "expected-label-capitalized");
const chatId = "oc_feishu_content_107947";
const appId = "cli_feishu_content_107947";
const authorization = "Bearer tat-feishu-content-107947";
const messagePath = "/open-apis/im/v1/messages";
const textBody = (text: string) => ({ content: JSON.stringify({ text }) });

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return { ...actual, logVerbose: mockLogVerbose };
});

type RecordedMessageRequest = {
  method: string;
  path: string;
  cardMessageContentType?: string;
  appId?: string;
  authorization?: string;
  messageType?: unknown;
  content?: unknown;
  receiveId?: unknown;
  replyInThread?: unknown;
};

describe("Feishu message content over the real Lark SDK", () => {
  it("authenticates message reads and sticker sends without exposing malformed content", async () => {
    const requests: RecordedMessageRequest[] = [];
    const sensitiveContentByMessageId = new Map([
      ["om_loopback_bad_text", { type: "text", content: "LKTEXT107" }],
      ["om_loopback_bad_post", { type: "post", content: "LKPOST107" }],
      ["om_loopback_bad_card", { type: "interactive", content: "LKCARD107" }],
    ]);

    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }

        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const record: RecordedMessageRequest = {
          method: request.method ?? "",
          path: url.pathname,
          ...(url.searchParams.get("card_msg_content_type")
            ? { cardMessageContentType: url.searchParams.get("card_msg_content_type") ?? undefined }
            : {}),
          ...(typeof body.app_id === "string" ? { appId: body.app_id } : {}),
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          ...(body.msg_type ? { messageType: body.msg_type, content: body.content } : {}),
          ...(body.receive_id ? { receiveId: body.receive_id } : {}),
          ...(body.reply_in_thread ? { replyInThread: body.reply_in_thread } : {}),
        };
        requests.push(record);

        const sendJson = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        const sendItems = (items: object[]) =>
          sendJson(200, { code: 0, msg: "ok", data: { items } });

        if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
          if (
            request.method !== "POST" ||
            body.app_id !== appId ||
            body.app_secret !== "loopback-placeholder"
          ) {
            return sendJson(401, { code: 99991663, msg: "invalid loopback application" });
          }
          return sendJson(200, {
            code: 0,
            msg: "ok",
            tenant_access_token: "tat-feishu-content-107947",
            expire: 7200,
          });
        }

        if (record.authorization !== authorization) {
          return sendJson(401, { code: 99991663, msg: "missing authenticated message request" });
        }
        if (url.pathname.startsWith("/open-apis/contact/v3/users/")) {
          return sendJson(200, {
            code: 0,
            data: {
              user: {
                name: url.pathname.endsWith("/ou_loopback_merge_child_sender")
                  ? "Alice"
                  : undefined,
              },
            },
          });
        }

        if (request.method === "POST" && body.msg_type === "sticker") {
          if (url.pathname === "/open-apis/im/v1/messages/om_withdrawn_sticker/reply") {
            return sendJson(200, { code: 230011, msg: "The message was withdrawn." });
          }
          const isCreate = url.pathname === messagePath;
          const isReply = url.pathname === "/open-apis/im/v1/messages/om_received_sticker/reply";
          if ((isCreate && url.searchParams.get("receive_id_type") === "chat_id") || isReply) {
            return sendJson(200, {
              code: 0,
              data: { message_id: isCreate ? "om_sticker_sent" : "om_sticker_reply" },
            });
          }
        }

        if (request.method !== "GET" || record.cardMessageContentType !== "user_card_content") {
          return sendJson(400, { code: 400, msg: "unexpected loopback request" });
        }

        const messageId = url.pathname.match(/^\/open-apis\/im\/v1\/messages\/([^/]+)$/)?.[1];
        if (!messageId) {
          return sendJson(404, { code: 404, msg: "unexpected loopback message route" });
        }

        if (messageId === "om_loopback_vendor_error") {
          return sendJson(200, { code: 230001, msg: "message not found" });
        }

        if (messageId === "om_loopback_merge_forward") {
          const child = (message_id: string, text: string, create_time: string, id: string) => ({
            message_id,
            upper_message_id: messageId,
            msg_type: "text",
            body: textBody(text),
            create_time,
            sender: { id, id_type: "open_id" },
          });
          return sendItems([
            {
              message_id: messageId,
              chat_id: chatId,
              chat_type: "group",
              msg_type: "merge_forward",
              body: textBody("Merged and Forwarded Message"),
            },
            child(
              "om_loopback_merge_child",
              "forwarded context",
              "1710000000000",
              "ou_loopback_merge_child_sender",
            ),
            child(
              "om_loopback_second_child",
              "second context",
              "1710000001000",
              "ou_loopback_unknown",
            ),
          ]);
        }

        const malformed = sensitiveContentByMessageId.get(messageId);
        const message = malformed
          ? { msg_type: malformed.type, body: { content: malformed.content } }
          : messageId === "om_loopback_valid_text"
            ? { msg_type: "text", body: textBody("safe message") }
            : messageId === "om_loopback_empty_text"
              ? { msg_type: "text", body: { content: "" } }
              : undefined;

        if (!message) {
          return sendJson(404, { code: 404, msg: "unknown loopback message" });
        }

        sendItems([{ message_id: messageId, chat_id: chatId, chat_type: "group", ...message }]);
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const loopbackOrigin = `http://127.0.0.1:${address.port}`;
    // Preserve the real SDK domain; its path filler interprets custom :port
    // values as route parameters. Redirect the original Axios transport only.
    const loopbackInterceptor = Lark.defaultHttpInstance.interceptors.request.use(
      (options) => {
        const upstream = new URL(options.url ?? "");
        if (upstream.hostname === "open.feishu.cn") {
          options.url = new URL(
            `${upstream.pathname}${upstream.search}`,
            loopbackOrigin,
          ).toString();
        }
        return options;
      },
      undefined,
      { synchronous: true },
    );

    try {
      mockLogVerbose.mockClear();
      const cfg = {
        channels: {
          feishu: {
            enabled: true,
            appId,
            appSecret: "loopback-placeholder", // pragma: allowlist secret
            domain: "feishu",
            actions: { sticker: true },
            stickerSets: {
              [appId]: { file_sticker_received: ["赞👍"] },
            },
          },
        },
      } as ClawdbotConfig;
      const readMessage = (messageId: string, expected: object, config = cfg) =>
        expect(getMessageFeishu({ cfg: config, messageId })).resolves.toMatchObject(expected);
      const mergedContent = (sender: string) =>
        "[Merged and Forwarded Messages]\n" +
        `- [2024-03-09T16:00:00.000Z] ${sender}: forwarded context\n` +
        "- [2024-03-09T16:00:01.000Z] ou_loopback_unknown: second context";

      for (const [messageId, malformed] of sensitiveContentByMessageId) {
        let exposedParserError: unknown;
        try {
          JSON.parse(malformed.content);
        } catch (error) {
          exposedParserError = error;
        }
        expect(exposedParserError).toBeInstanceOf(SyntaxError);
        expect((exposedParserError as Error).message).toContain(malformed.content);

        await readMessage(messageId, {
          messageId,
          chatId,
          contentType: malformed.type,
          content: malformed.content,
        });
        expect(mockLogVerbose).toHaveBeenCalledWith(
          `feishu message content parse failed for ${malformed.type} message (id: ${messageId})`,
        );
      }

      await readMessage("om_loopback_valid_text", {
        messageId: "om_loopback_valid_text",
        contentType: "text",
        content: "safe message",
      });

      await readMessage("om_loopback_empty_text", {
        messageId: "om_loopback_empty_text",
        contentType: "text",
        content: "",
      });

      await readMessage("om_loopback_merge_forward", {
        messageId: "om_loopback_merge_forward",
        contentType: "merge_forward",
        content: mergedContent("Alice"),
      });
      await readMessage(
        "om_loopback_merge_forward",
        { content: mergedContent("ou_loopback_merge_child_sender") },
        {
          ...cfg,
          channels: { feishu: { ...cfg.channels?.feishu, resolveSenderNames: false } },
        },
      );

      await expect(
        getMessageFeishu({ cfg, messageId: "om_loopback_vendor_error" }),
      ).resolves.toBeNull();

      const loggedValues = mockLogVerbose.mock.calls.flat().map(String).join("\n");
      for (const { content } of sensitiveContentByMessageId.values()) {
        expect(loggedValues).not.toContain(content);
      }
      expect(loggedValues).not.toContain("loopback-placeholder");
      expect(mockLogVerbose).toHaveBeenCalledTimes(sensitiveContentByMessageId.size);

      expect(requests.filter((request) => request.path.includes("tenant_access_token"))).toEqual([
        {
          method: "POST",
          path: "/open-apis/auth/v3/tenant_access_token/internal",
          appId,
        },
      ]);
      const messageReads = requests.filter(
        (request) => request.method === "GET" && request.path.startsWith("/open-apis/im/"),
      );
      expect(messageReads).toHaveLength(8);
      for (const request of messageReads) {
        expect(request).toMatchObject({
          authorization,
          cardMessageContentType: "user_card_content",
        });
      }

      const requestCountBeforeSticker = requests.length;
      await expect(
        resolveFeishuMediaList({
          cfg,
          messageId: "om_received_sticker",
          messageType: "sticker",
          content: JSON.stringify({ file_key: "file_sticker_received" }),
          maxBytes: 1024,
        }),
      ).resolves.toEqual([]);
      expect(requests).toHaveLength(requestCountBeforeSticker);

      const searchResult = await feishuPlugin.actions!.handleAction!({
        channel: "feishu",
        action: "sticker-search",
        cfg,
        accountId: "default",
        params: { query: "赞" },
      });
      expect(searchResult.details).toEqual({
        stickers: [{ fileId: "file_sticker_received", keyword: "赞👍" }],
        truncated: false,
      });
      expect(requests).toHaveLength(requestCountBeforeSticker);
      const searchDetails = requireRecord(searchResult.details, "search details");
      const stickers = searchDetails.stickers;
      if (!Array.isArray(stickers)) {
        throw new Error("Expected sticker search results");
      }
      const sticker = requireRecord(stickers[0], "sticker");
      for (const replyInThread of [false, true]) {
        const result = await feishuPlugin.actions!.handleAction!({
          channel: "feishu",
          action: "sticker",
          cfg,
          accountId: "default",
          params: {
            ...sticker,
            to: `chat:${chatId}`,
            ...(replyInThread ? { threadId: "om_received_sticker" } : {}),
          },
        });
        expect(result.details).toMatchObject({
          messageId: replyInThread ? "om_sticker_reply" : "om_sticker_sent",
          receipt: { parts: [expect.objectContaining({ kind: "media" })] },
        });
      }
      const stickerRequest = {
        method: "POST",
        authorization,
        messageType: "sticker",
        content: JSON.stringify({ file_key: "file_sticker_received" }),
      };
      expect(requests.filter((request) => request.messageType === "sticker")).toEqual([
        {
          ...stickerRequest,
          path: messagePath,
          receiveId: chatId,
        },
        {
          ...stickerRequest,
          path: "/open-apis/im/v1/messages/om_received_sticker/reply",
          replyInThread: true,
        },
      ]);
      const creates = () => requests.filter((request) => request.path === messagePath);
      const createsBeforeWithdrawnReply = creates().length;
      await expect(
        sendStickerFeishu({
          cfg,
          to: `chat:${chatId}`,
          fileKey: "file_sticker_received",
          replyToMessageId: "om_withdrawn_sticker",
          replyInThread: true,
        }),
      ).rejects.toThrow("cannot safely fall back to a top-level send");
      expect(creates()).toHaveLength(createsBeforeWithdrawnReply);
    } finally {
      Lark.defaultHttpInstance.interceptors.request.eject(loopbackInterceptor);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
