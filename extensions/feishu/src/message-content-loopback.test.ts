// Prove Feishu message parsing against the real SDK, auth exchange, and HTTP transport.
import type { IncomingMessage } from "node:http";
import { text as readText } from "node:stream/consumers";
import * as Lark from "@larksuiteoapi/node-sdk";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
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
const authPath = "/open-apis/auth/v3/tenant_access_token/internal";
const stickerReplyPath = `${messagePath}/om_received_sticker/reply`;
const mergeId = "om_loopback_merge_forward";
const senderId = "ou_loopback_merge_child_sender";
const textBody = (text: string) => ({ content: JSON.stringify({ text }) });

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return { ...actual, logVerbose: mockLogVerbose };
});

function recordRequest(request: IncomingMessage, url: URL, body: Record<string, unknown>) {
  return {
    method: request.method ?? "",
    path: url.pathname,
    cardMessageContentType: url.searchParams.get("card_msg_content_type") ?? undefined,
    appId: body.app_id,
    authorization: request.headers.authorization,
    messageType: body.msg_type,
    content: body.content,
    receiveId: body.receive_id,
    replyInThread: body.reply_in_thread,
  };
}

it("authenticates Feishu reads and sticker sends over the real SDK without exposing malformed content", async () => {
  const requests: ReturnType<typeof recordRequest>[] = [];
  const sensitiveContentByMessageId = new Map([
    ["om_loopback_bad_text", { type: "text", content: "LKTEXT107" }],
    ["om_loopback_bad_post", { type: "post", content: "LKPOST107" }],
    ["om_loopback_bad_card", { type: "interactive", content: "LKCARD107" }],
  ]);

  await withServer(
    (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const body = JSON.parse((await readText(request)) || "{}") as Record<string, unknown>;
        const record = recordRequest(request, url, body);
        requests.push(record);

        const sendJson = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        const sendItems = (items: object[]) =>
          sendJson(200, { code: 0, msg: "ok", data: { items } });

        if (url.pathname === authPath) {
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
          const name = url.pathname.endsWith(`/${senderId}`) ? "Alice" : undefined;
          return sendJson(200, { code: 0, data: { user: { name } } });
        }

        if (request.method === "POST" && body.msg_type === "sticker") {
          if (url.pathname === "/open-apis/im/v1/messages/om_withdrawn_sticker/reply") {
            return sendJson(200, { code: 230011, msg: "The message was withdrawn." });
          }
          const isCreate = url.pathname === messagePath;
          const isReply = url.pathname === stickerReplyPath;
          if ((isCreate && url.searchParams.get("receive_id_type") === "chat_id") || isReply) {
            const messageId = isCreate ? "om_sticker_sent" : "om_sticker_reply";
            return sendJson(200, { code: 0, data: { message_id: messageId } });
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

        if (messageId === mergeId) {
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
            child("om_child1", "forwarded context", "1710000000000", senderId),
            child("om_child2", "second context", "1710000001000", "ou_loopback_unknown"),
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
    },
    async (loopbackOrigin) => {
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
        const feishu = {
          enabled: true,
          appId,
          appSecret: "loopback-placeholder", // pragma: allowlist secret
          domain: "feishu",
          actions: { sticker: true },
          stickerSets: { [appId]: { file_sticker_received: ["赞👍"] } },
        };
        const cfg: ClawdbotConfig = { channels: { feishu } };
        const action = (kind: "sticker" | "sticker-search", params: Record<string, unknown>) =>
          feishuPlugin.actions!.handleAction!({
            channel: "feishu",
            action: kind,
            cfg,
            accountId: "default",
            params,
          });
        const readMessage = (messageId: string, expected: object, config = cfg) =>
          expect(getMessageFeishu({ cfg: config, messageId })).resolves.toMatchObject({
            messageId,
            ...expected,
          });
        const mergedContent = (sender: string) =>
          "[Merged and Forwarded Messages]\n" +
          `- [2024-03-09T16:00:00.000Z] ${sender}: forwarded context\n` +
          "- [2024-03-09T16:00:01.000Z] ou_loopback_unknown: second context";

        for (const [messageId, malformed] of sensitiveContentByMessageId) {
          expect(() => JSON.parse(malformed.content)).toThrow(SyntaxError);
          expect(() => JSON.parse(malformed.content)).toThrow(malformed.content);

          await readMessage(messageId, {
            chatId,
            contentType: malformed.type,
            content: malformed.content,
          });
          expect(mockLogVerbose).toHaveBeenCalledWith(
            `feishu message content parse failed for ${malformed.type} message (id: ${messageId})`,
          );
        }

        for (const [messageId, content] of [
          ["om_loopback_valid_text", "safe message"],
          ["om_loopback_empty_text", ""],
        ] as const) {
          await readMessage(messageId, { contentType: "text", content });
        }

        for (const resolveSenderNames of [undefined, false]) {
          await readMessage(
            mergeId,
            {
              contentType: "merge_forward",
              content: mergedContent(resolveSenderNames === false ? senderId : "Alice"),
            },
            { ...cfg, channels: { feishu: { ...feishu, resolveSenderNames } } },
          );
        }

        await expect(
          getMessageFeishu({ cfg, messageId: "om_loopback_vendor_error" }),
        ).resolves.toBeNull();

        const loggedValues = mockLogVerbose.mock.calls.flat().map(String).join("\n");
        for (const { content } of sensitiveContentByMessageId.values()) {
          expect(loggedValues).not.toContain(content);
        }
        expect(loggedValues).not.toContain("loopback-placeholder");
        expect(mockLogVerbose).toHaveBeenCalledTimes(sensitiveContentByMessageId.size);

        const authRequests = requests.filter(({ path }) => path.includes("tenant_access_token"));
        expect(authRequests).toEqual([{ method: "POST", path: authPath, appId }]);
        const messageReads = requests.filter(
          (request) => request.method === "GET" && request.path.startsWith("/open-apis/im/"),
        );
        expect(messageReads).toHaveLength(8);
        const expectedRead = { authorization, cardMessageContentType: "user_card_content" };
        for (const request of messageReads) {
          expect(request).toMatchObject(expectedRead);
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

        const searchResult = await action("sticker-search", { query: "赞" });
        expect(searchResult.details).toEqual({
          stickers: [{ fileId: "file_sticker_received", keyword: "赞👍" }],
          truncated: false,
        });
        expect(requests).toHaveLength(requestCountBeforeSticker);
        const { stickers } = requireRecord(searchResult.details, "search details");
        if (!Array.isArray(stickers)) {
          throw new Error("Expected sticker search results");
        }
        const sticker = requireRecord(stickers[0], "sticker");
        for (const replyInThread of [false, true]) {
          const result = await action("sticker", {
            ...sticker,
            to: `chat:${chatId}`,
            ...(replyInThread ? { threadId: "om_received_sticker" } : {}),
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
          { ...stickerRequest, path: messagePath, receiveId: chatId },
          { ...stickerRequest, path: stickerReplyPath, replyInThread: true },
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
      }
    },
  );
});
