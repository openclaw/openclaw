// Prove Feishu DM routing against the real SDK, token exchange, and HTTP transport.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { sendMediaFeishu } from "./media.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

type RecordedFeishuRequest = {
  method: string;
  path: string;
  receiveIdType?: string;
  receiveId?: string;
  messageType?: string;
  appId?: string;
  authorization?: string;
  replyInThread?: boolean;
};

describe("Feishu DM delivery over the real Lark SDK", () => {
  it("reacquires one stale primary token without touching the secondary account", async () => {
    const tokenCalls = new Map<string, number>();
    const messageCalls = new Map<string, number>();
    const visibleSends = new Map<string, number>();
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        const sendJson = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };

        if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
          const appId = String(body.app_id);
          const count = (tokenCalls.get(appId) ?? 0) + 1;
          tokenCalls.set(appId, count);
          sendJson(200, {
            code: 0,
            msg: "ok",
            tenant_access_token:
              appId === "cli_stale_primary" && count === 1
                ? "tat-primary-stale"
                : appId === "cli_stale_primary"
                  ? "tat-primary-fresh"
                  : "tat-secondary-valid",
            expire: 7200,
          });
          return;
        }

        const authorization = String(request.headers.authorization);
        messageCalls.set(authorization, (messageCalls.get(authorization) ?? 0) + 1);
        if (authorization === "Bearer tat-primary-stale") {
          sendJson(401, { code: 99991663, msg: "invalid tenant access token" });
          return;
        }
        const receiveId = String(body.receive_id);
        visibleSends.set(receiveId, (visibleSends.get(receiveId) ?? 0) + 1);
        sendJson(200, {
          code: 0,
          msg: "success",
          data: { message_id: `om_${receiveId}` },
        });
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
    const interceptor = Lark.defaultHttpInstance.interceptors.request.use(
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
      const cfg = {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_stale_primary",
            appSecret: "loopback-placeholder", // pragma: allowlist secret
            domain: "feishu",
            accounts: {
              secondary: {
                appId: "cli_valid_secondary",
                appSecret: "loopback-placeholder", // pragma: allowlist secret
                domain: "feishu",
              },
            },
          },
        },
      } as ClawdbotConfig;

      await expect(
        sendMessageFeishu({ cfg, to: "chat:oc_primary", text: "primary" }),
      ).resolves.toMatchObject({ messageId: "om_oc_primary" });
      await expect(
        sendMessageFeishu({
          cfg,
          to: "chat:oc_secondary",
          text: "secondary",
          accountId: "secondary",
        }),
      ).resolves.toMatchObject({ messageId: "om_oc_secondary" });

      expect(tokenCalls).toEqual(
        new Map([
          ["cli_stale_primary", 2],
          ["cli_valid_secondary", 1],
        ]),
      );
      expect(messageCalls).toEqual(
        new Map([
          ["Bearer tat-primary-stale", 1],
          ["Bearer tat-primary-fresh", 1],
          ["Bearer tat-secondary-valid", 1],
        ]),
      );
      expect(visibleSends).toEqual(
        new Map([
          ["oc_primary", 1],
          ["oc_secondary", 1],
        ]),
      );
    } finally {
      Lark.defaultHttpInstance.interceptors.request.eject(interceptor);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("authenticates conversation replies and preserves account, group, thread, and error boundaries", async () => {
    const requests: RecordedFeishuRequest[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }

        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const path = url.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const isJson = (request.headers["content-type"] ?? "").includes("application/json");
        const body = isJson && rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const record: RecordedFeishuRequest = {
          method: request.method ?? "",
          path,
          ...(url.searchParams.get("receive_id_type")
            ? { receiveIdType: url.searchParams.get("receive_id_type") ?? undefined }
            : {}),
          ...(typeof body.receive_id === "string" ? { receiveId: body.receive_id } : {}),
          ...(typeof body.msg_type === "string" ? { messageType: body.msg_type } : {}),
          ...(typeof body.app_id === "string" ? { appId: body.app_id } : {}),
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          ...(body.reply_in_thread === true ? { replyInThread: true } : {}),
        };
        requests.push(record);

        const sendJson = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };

        if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
          if (body.app_id !== "cli_dm_primary" && body.app_id !== "cli_dm_secondary") {
            sendJson(401, { code: 99991663, msg: "unknown loopback test application" });
            return;
          }
          sendJson(200, {
            code: 0,
            msg: "ok",
            tenant_access_token: body.app_id === "cli_dm_primary" ? "tat-primary" : "tat-secondary",
            expire: 7200,
          });
          return;
        }

        if (
          record.authorization !== "Bearer tat-primary" &&
          record.authorization !== "Bearer tat-secondary"
        ) {
          sendJson(401, { code: 99991663, msg: "missing account-scoped tenant token" });
          return;
        }

        if (path === "/open-apis/im/v1/images") {
          sendJson(200, { code: 0, msg: "success", data: { image_key: "img_dm_loopback" } });
          return;
        }

        if (path === "/open-apis/im/v1/messages/om_dm_thread_root/reply") {
          sendJson(200, {
            code: 0,
            msg: "success",
            data: { message_id: "om_dm_thread_reply" },
          });
          return;
        }

        if (path !== "/open-apis/im/v1/messages") {
          sendJson(404, { code: 404, msg: "unexpected loopback request" });
          return;
        }

        if (body.receive_id === "ou_dm_unavailable") {
          sendJson(400, {
            code: 230101,
            msg: "Sending messages to users is temporarily unavailable.",
          });
          return;
        }

        if (body.receive_id === "ou_dm_forbidden") {
          sendJson(400, { code: 230027, msg: "Lack of necessary permissions." });
          return;
        }

        sendJson(200, {
          code: 0,
          msg: "success",
          data: { message_id: `om_dm_loopback_${requests.length}` },
        });
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
    // Keep the production Feishu domain: the SDK treats a :port in a custom
    // base URL as an API path parameter. The real Axios request interceptor
    // redirects both its token POST and authenticated message transport.
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
      const cfg = {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_dm_primary",
            appSecret: "loopback-placeholder", // pragma: allowlist secret
            domain: "feishu",
            accounts: {
              secondary: {
                appId: "cli_dm_secondary",
                appSecret: "loopback-placeholder", // pragma: allowlist secret
                domain: "feishu",
              },
            },
          },
        },
      } as ClawdbotConfig;

      await expect(
        sendMessageFeishu({ cfg, to: "user:ou_dm_unavailable", text: "old DM target" }),
      ).rejects.toThrow(/230101|temporarily unavailable/);

      await expect(
        sendMessageFeishu({ cfg, to: "chat:oc_dm_conversation", text: "delivered DM" }),
      ).resolves.toMatchObject({ chatId: "oc_dm_conversation" });

      await expect(
        sendCardFeishu({
          cfg,
          to: "chat:oc_dm_conversation",
          card: { elements: [{ tag: "markdown", content: "delivered DM card" }] },
        }),
      ).resolves.toMatchObject({ chatId: "oc_dm_conversation" });

      await expect(
        sendMediaFeishu({
          cfg,
          to: "chat:oc_dm_conversation",
          mediaBuffer: Buffer.from(
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
            "hex",
          ),
          fileName: "loopback.png",
        }),
      ).resolves.toMatchObject({ chatId: "oc_dm_conversation" });

      await expect(
        sendMessageFeishu({ cfg, to: "chat:oc_group_conversation", text: "group control" }),
      ).resolves.toMatchObject({ chatId: "oc_group_conversation" });

      await expect(
        sendMessageFeishu({
          cfg,
          to: "chat:oc_dm_conversation",
          text: "thread control",
          replyToMessageId: "om_dm_thread_root",
          replyInThread: true,
        }),
      ).resolves.toMatchObject({ messageId: "om_dm_thread_reply" });

      await expect(
        sendMessageFeishu({
          cfg,
          to: "chat:oc_secondary_conversation",
          text: "secondary account control",
          accountId: "secondary",
        }),
      ).resolves.toMatchObject({ chatId: "oc_secondary_conversation" });

      await expect(
        sendMessageFeishu({ cfg, to: "user:ou_dm_allowed", text: "proactive control" }),
      ).resolves.toMatchObject({ chatId: "ou_dm_allowed" });

      await expect(
        sendMessageFeishu({ cfg, to: "user:ou_dm_forbidden", text: "permission control" }),
      ).rejects.toThrow(/230027|necessary permissions/);

      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/open-apis/auth/v3/tenant_access_token/internal",
            appId: "cli_dm_primary",
          }),
          expect.objectContaining({
            path: "/open-apis/auth/v3/tenant_access_token/internal",
            appId: "cli_dm_secondary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "open_id",
            receiveId: "ou_dm_unavailable",
            authorization: "Bearer tat-primary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_dm_conversation",
            messageType: "post",
            authorization: "Bearer tat-primary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_dm_conversation",
            messageType: "interactive",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/images",
            authorization: "Bearer tat-primary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_dm_conversation",
            messageType: "image",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_group_conversation",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages/om_dm_thread_root/reply",
            replyInThread: true,
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "chat_id",
            receiveId: "oc_secondary_conversation",
            authorization: "Bearer tat-secondary",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "open_id",
            receiveId: "ou_dm_allowed",
          }),
          expect.objectContaining({
            path: "/open-apis/im/v1/messages",
            receiveIdType: "open_id",
            receiveId: "ou_dm_forbidden",
          }),
        ]),
      );
    } finally {
      Lark.defaultHttpInstance.interceptors.request.eject(loopbackInterceptor);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
