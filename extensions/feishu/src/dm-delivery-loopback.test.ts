// Prove Feishu DM routing against the real SDK, token exchange, and HTTP transport.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { sendMediaFeishu } from "./media.js";
import { feishuOutbound } from "./outbound.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

const messagePath = "/open-apis/im/v1/messages";
const authPath = "/open-apis/auth/v3/tenant_access_token/internal";
type RecordedFeishuRequest = {
  path: string;
  receiveIdType?: string;
  receiveId?: string;
  messageType?: string;
  appId?: string;
  authorization?: string;
  replyInThread?: boolean;
  content?: string;
  platformMessageId?: string;
};

it("Feishu DM delivery preserves routing, card byte envelopes and physical-send receipts over the real Lark SDK", async () => {
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
      const string = (value: unknown) => (typeof value === "string" ? value : undefined);
      const record: RecordedFeishuRequest = {
        path,
        receiveIdType: url.searchParams.get("receive_id_type") || undefined,
        receiveId: string(body.receive_id),
        messageType: string(body.msg_type),
        appId: string(body.app_id),
        authorization: string(request.headers.authorization),
        replyInThread: body.reply_in_thread === true ? true : undefined,
        content: string(body.content),
      };
      requests.push(record);

      const sendJson = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const success = (data: unknown) => sendJson(200, { code: 0, msg: "success", data });

      if (path === authPath) {
        if (body.app_id !== "cli_dm_primary" && body.app_id !== "cli_dm_secondary") {
          return sendJson(401, { code: 99991663, msg: "unknown loopback test application" });
        }
        return sendJson(200, {
          code: 0,
          msg: "ok",
          tenant_access_token: body.app_id === "cli_dm_primary" ? "tat-primary" : "tat-secondary",
          expire: 7200,
        });
      }

      if (
        record.authorization !== "Bearer tat-primary" &&
        record.authorization !== "Bearer tat-secondary"
      ) {
        return sendJson(401, { code: 99991663, msg: "missing account-scoped tenant token" });
      }

      if (path === "/open-apis/im/v1/images") {
        return success({ image_key: "img_dm_loopback" });
      }

      if (
        path === `${messagePath}/om_dm_thread_root/reply` ||
        path === `${messagePath}/om_card_split_root/reply`
      ) {
        record.platformMessageId = path.includes("om_dm_thread_root")
          ? "om_dm_thread_reply"
          : `om_dm_loopback_${requests.length}`;
        return success({ message_id: record.platformMessageId });
      }

      if (path !== messagePath) {
        return sendJson(404, { code: 404, msg: "unexpected loopback request" });
      }

      if (body.receive_id === "ou_dm_unavailable") {
        return sendJson(400, {
          code: 230101,
          msg: "Sending messages to users is temporarily unavailable.",
        });
      }

      if (
        body.receive_id === "ou_dm_forbidden" ||
        (body.receive_id === "oc_card_partial" &&
          requests.filter((entry) => entry.receiveId === body.receive_id).length === 3)
      ) {
        return sendJson(400, { code: 230027, msg: "Lack of necessary permissions." });
      }

      record.platformMessageId = `om_dm_loopback_${requests.length}`;
      success({ message_id: record.platformMessageId });
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const loopbackOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const account = (appId: string) => ({
      appId,
      appSecret: "loopback-placeholder", // pragma: allowlist secret
      domain: loopbackOrigin,
    });
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          ...account("cli_dm_primary"),
          accounts: { secondary: account("cli_dm_secondary") },
        },
      },
    } as ClawdbotConfig;
    type MessageOptions = Omit<Parameters<typeof sendMessageFeishu>[0], "cfg" | "to" | "text">;
    const sendPost = (to: string, options: MessageOptions = {}) =>
      sendMessageFeishu({ cfg, to, text: "routing control", ...options });
    const expectRequest = (record: Partial<RecordedFeishuRequest>) =>
      expect(requests).toEqual(expect.arrayContaining([expect.objectContaining(record)]));
    const expectMessage = (receiveId: string, fields: Partial<RecordedFeishuRequest> = {}) =>
      expectRequest({ path: messagePath, receiveIdType: "chat_id", receiveId, ...fields });

    await expect(sendPost("user:ou_dm_unavailable")).rejects.toThrow(
      /230101|temporarily unavailable/,
    );
    const routes: Array<[string, string, string?]> = [
      ["chat:oc_dm_conversation", "oc_dm_conversation"],
      ["chat:oc_group_conversation", "oc_group_conversation"],
      ["chat:oc_secondary_conversation", "oc_secondary_conversation", "secondary"],
      ["user:ou_dm_allowed", "ou_dm_allowed"],
    ];
    for (const [to, chatId, accountId] of routes) {
      await expect(sendPost(to, { accountId })).resolves.toMatchObject({ chatId });
    }

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
      sendPost("chat:oc_dm_conversation", {
        replyToMessageId: "om_dm_thread_root",
        replyInThread: true,
      }),
    ).resolves.toMatchObject({ messageId: "om_dm_thread_reply" });

    await expect(sendPost("user:ou_dm_forbidden")).rejects.toThrow(/230027|necessary permissions/);

    for (const appId of ["cli_dm_primary", "cli_dm_secondary"]) {
      expectRequest({ path: authPath, appId });
    }
    expectMessage("ou_dm_unavailable", {
      receiveIdType: "open_id",
      authorization: "Bearer tat-primary",
    });
    expectMessage("oc_dm_conversation", {
      messageType: "post",
      authorization: "Bearer tat-primary",
    });
    for (const messageType of ["interactive", "image"]) {
      expectMessage("oc_dm_conversation", { messageType });
    }
    expectRequest({ path: "/open-apis/im/v1/images", authorization: "Bearer tat-primary" });
    expectMessage("oc_group_conversation");
    expectRequest({ path: `${messagePath}/om_dm_thread_root/reply`, replyInThread: true });
    expectMessage("oc_secondary_conversation", { authorization: "Bearer tat-secondary" });
    for (const receiveId of ["ou_dm_allowed", "ou_dm_forbidden"]) {
      expectMessage(receiveId, { receiveIdType: "open_id" });
    }

    type SendTextParams = Parameters<NonNullable<typeof feishuOutbound.sendText>>[0];
    const sendText = (
      params: Omit<SendTextParams, "cfg" | "to"> & Partial<Pick<SendTextParams, "cfg" | "to">>,
    ) => feishuOutbound.sendText!({ cfg, to: "chat:oc_dm_conversation", ...params });
    const withLimit = (textChunkLimit: number) => ({
      ...cfg,
      channels: { feishu: { ...cfg.channels!.feishu, textChunkLimit } },
    });
    const sentIds = (start: number) =>
      requests.slice(start).flatMap((request) => request.platformMessageId ?? []);
    const expectPartial = async (params: Parameters<typeof sendText>[0]) => {
      const start = requests.length;
      const caught: unknown = await sendText(params).catch((error: unknown) => error);
      const ids = sentIds(start);
      expect(ids).toHaveLength(2);
      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      if (!isChannelPartialDeliveryError(caught)) {
        throw caught;
      }
      expect(caught.deliveryResult.messageIds).toEqual(ids);
      return caught;
    };
    for (const fixture of [
      { name: "default limit", body: "漢".repeat(11_000), limit: 4_000, header: "Header" },
      { name: "UTF-8 bytes", body: "漢".repeat(11_000), limit: 25_000, header: "Header" },
      { name: "JSON escapes", body: '"\\'.repeat(8_000), limit: 25_000, header: "Header" },
      {
        name: "header and fence overhead",
        body: "x".repeat(24_576),
        limit: 25_000,
        header: "界".repeat(2_000),
      },
    ]) {
      for (const thread of [false, true]) {
        const before = requests.length;
        const deliveries: string[] = [];
        const result = await sendText({
          cfg: withLimit(fixture.limit),
          text: `\`\`\`text\n${fixture.body}\n\`\`\``,
          identity: { name: fixture.header },
          ...(thread ? { threadId: "om_card_split_root" } : {}),
          onDeliveryResult: (delivery) => {
            deliveries.push(delivery.messageId);
          },
        });
        const sent = requests.slice(before).filter((request) => request.messageType);
        expect
          .soft(sent.length, `${fixture.name}: split direct card, thread=${thread}`)
          .toBeGreaterThan(1);
        const bodies: string[] = [];
        for (const request of sent) {
          expect(request).toMatchObject({
            messageType: "interactive",
            path: thread ? `${messagePath}/om_card_split_root/reply` : messagePath,
            replyInThread: thread ? true : undefined,
          });
          expect
            .soft(Buffer.byteLength(request.content!, "utf8"), fixture.name)
            .toBeLessThanOrEqual(30 * 1024);
          const card = JSON.parse(request.content!) as {
            header: { title: { content: string } };
            body: { elements: Array<{ tag: string; content: string }> };
          };
          expect(card.header.title.content).toBe(fixture.header);
          const markdown = card.body.elements[0]?.content;
          if (markdown === undefined) {
            throw new Error("Expected a Markdown card body");
          }
          expect(markdown).toMatch(/^```text\n[\s\S]*\n```(?![\s\S])/);
          bodies.push(markdown.slice(8, -4));
        }
        expect(bodies.join("")).toBe(fixture.body);
        expect(deliveries).toEqual(sent.map((request) => request.platformMessageId));
        expect.soft(result.receipt?.platformMessageIds, fixture.name).toEqual(deliveries);
        expect(result.messageId).toBe(deliveries.at(-1));
        expect(result.receipt?.primaryPlatformMessageId).toBe(result.messageId);
      }
    }

    const postStart = requests.length;
    const post = await sendText({ text: "漢".repeat(11_000) });
    const postIds = sentIds(postStart);
    expect(postIds.length).toBeGreaterThan(1);
    expect
      .soft(post.receipt?.platformMessageIds, "logical post receipt contains every physical send")
      .toEqual(postIds);

    const partialError = await expectPartial({
      cfg: withLimit(10),
      to: "chat:oc_card_partial",
      text: "abcdefghij".repeat(3),
    });
    expect(partialError.deliveryResult.visibleReplySent).toBe(true);

    let callbacks = 0;
    await expectPartial({
      text: "漢".repeat(11_000),
      onDeliveryResult: () => {
        if (++callbacks === 2) {
          throw new Error("recording failed");
        }
      },
    });
    expect(callbacks).toBe(2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
