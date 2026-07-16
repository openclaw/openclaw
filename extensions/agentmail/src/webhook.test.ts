import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Webhook } from "svix";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentMailAccount } from "./types.js";
import { createAgentMailWebhookHandler } from "./webhook.js";

const hookVal = ["wh", "sec_", Buffer.alloc(32, 7).toString("base64")].join("");

function account(): ResolvedAgentMailAccount {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "key",
    inboxId: "inbox_1",
    webhookSecret: hookVal,
    webhookPath: "/webhooks/agentmail",
    dmPolicy: "allowlist",
    allowFrom: ["sender@example.com"],
    mediaMaxBytes: 20 * 1024 * 1024,
  };
}

function request(body: string, headers: Record<string, string>): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-length": String(Buffer.byteLength(body)), ...headers };
  return req;
}

function response(): ServerResponse & { body?: string; setHeaderMock: ReturnType<typeof vi.fn> } {
  const setHeaderMock = vi.fn();
  return {
    statusCode: 200,
    setHeader: setHeaderMock,
    setHeaderMock,
    end: vi.fn(function (this: ServerResponse & { body?: string }, body?: string) {
      this.body = body;
      return this;
    }),
  } as never;
}

function signed(body: string) {
  const id = "msg_delivery_1";
  const timestamp = new Date();
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(hookVal).sign(id, timestamp, body),
  };
}

describe("AgentMail webhook", () => {
  it("verifies the raw body before committing durable ingress", async () => {
    const receive = vi.fn(async () => undefined);
    const body = JSON.stringify({
      type: "event",
      event_type: "message.received",
      event_id: "event_1",
      message: { inbox_id: "inbox_1", message_id: "message_1" },
    });
    const res = response();
    await createAgentMailWebhookHandler({ account: account(), receive })(
      request(body, signed(body)),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: "inbox_1",
        messageId: "message_1",
        eventId: "event_1",
        transport: "webhook",
      }),
    );
  });

  it("rejects invalid signatures and wrong inboxes", async () => {
    const receive = vi.fn(async () => undefined);
    const badRes = response();
    await createAgentMailWebhookHandler({ account: account(), receive })(
      request("{}", {
        "svix-id": "bad",
        "svix-timestamp": "0",
        "svix-signature": "v1,bad",
      }),
      badRes,
    );
    expect(badRes.statusCode).toBe(401);

    const body = JSON.stringify({
      type: "event",
      event_type: "message.received",
      message: { inbox_id: "inbox_other", message_id: "message_1" },
    });
    const wrongRes = response();
    await createAgentMailWebhookHandler({ account: account(), receive })(
      request(body, signed(body)),
      wrongRes,
    );
    expect(wrongRes.statusCode).toBe(200);
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests and acknowledges unsupported signed events", async () => {
    const receive = vi.fn(async () => undefined);
    const methodReq = request("", {});
    methodReq.method = "GET";
    const methodRes = response();
    await createAgentMailWebhookHandler({ account: account(), receive })(methodReq, methodRes);
    expect(methodRes.statusCode).toBe(405);
    expect(methodRes.setHeaderMock).toHaveBeenCalledWith("allow", "POST");

    const body = JSON.stringify({
      type: "event",
      event_type: "message.sent",
      message: { inbox_id: "inbox_1", message_id: "message_1" },
    });
    const unsupportedRes = response();
    await createAgentMailWebhookHandler({ account: account(), receive })(
      request(body, signed(body)),
      unsupportedRes,
    );
    expect(unsupportedRes.statusCode).toBe(200);
    expect(receive).not.toHaveBeenCalled();
  });

  it("acknowledges malformed signed received events without dispatch", async () => {
    const body = JSON.stringify({ type: "event", event_type: "message.received" });
    const res = response();
    const receive = vi.fn();
    await createAgentMailWebhookHandler({ account: account(), receive })(
      request(body, signed(body)),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(receive).not.toHaveBeenCalled();
  });

  it("returns retryable failure when durable receipt fails", async () => {
    const body = JSON.stringify({
      type: "event",
      event_type: "message.received",
      message: { inbox_id: "inbox_1", message_id: "message_1" },
    });
    const res = response();
    await createAgentMailWebhookHandler({
      account: account(),
      receive: async () => {
        throw new Error("queue unavailable");
      },
    })(request(body, signed(body)), res);
    expect(res.statusCode).toBe(503);
  });

  it("rejects oversized bodies before signature verification", async () => {
    const req = request("", {});
    req.headers["content-length"] = String(1024 * 1024 + 1);
    const res = response();
    await createAgentMailWebhookHandler({ account: account(), receive: vi.fn() })(req, res);
    expect(res.statusCode).toBe(413);
  });
});
