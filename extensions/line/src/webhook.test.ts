import crypto from "node:crypto";
import type { WebhookRequestBody } from "@line/bot-sdk";
import { describe, expect, it, vi } from "vitest";
import { createLineWebhookMiddleware, startLineWebhook } from "./webhook.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

const createRes = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent: false,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const SECRET = "secret";

async function invokeWebhook(params: {
  body: unknown;
  headers?: Record<string, string>;
  onEvents?: ReturnType<typeof vi.fn>;
  autoSign?: boolean;
}) {
  const onEventsMock = params.onEvents ?? vi.fn(async () => {});
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents: onEventsMock as unknown as (body: WebhookRequestBody) => Promise<void>,
  });

  const headers = { ...params.headers };
  const autoSign = params.autoSign ?? true;
  if (autoSign && !headers["x-line-signature"]) {
    if (typeof params.body === "string") {
      headers["x-line-signature"] = sign(params.body, SECRET);
    } else if (Buffer.isBuffer(params.body)) {
      headers["x-line-signature"] = sign(params.body.toString("utf-8"), SECRET);
    }
  }

  const req = {
    headers,
    body: params.body,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
  const res = createRes();
  // oxlint-disable-next-line typescript/no-explicit-any
  await middleware(req, res, {} as any);
  return { res, onEvents: onEventsMock };
}

async function expectSignedRawBodyWins(params: { rawBody: string | Buffer; signedUserId: string }) {
  const onEvents = vi.fn(async (_body: WebhookRequestBody) => {});
  const reqBody = {
    events: [{ type: "message", source: { userId: "tampered-user" } }],
  };
  const middleware = createLineWebhookMiddleware({
    channelSecret: SECRET,
    onEvents,
  });
  const rawBodyText =
    typeof params.rawBody === "string" ? params.rawBody : params.rawBody.toString("utf-8");
  const req = {
    headers: { "x-line-signature": sign(rawBodyText, SECRET) },
    rawBody: params.rawBody,
    body: reqBody,
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
  const res = createRes();

  // oxlint-disable-next-line typescript/no-explicit-any
  await middleware(req, res, {} as any);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(onEvents).toHaveBeenCalledTimes(1);
  const processedBody = onEvents.mock.calls[0]?.[0] as WebhookRequestBody | undefined;
  expect(processedBody?.events?.[0]?.source?.userId).toBe(params.signedUserId);
  expect(processedBody?.events?.[0]?.source?.userId).not.toBe("tampered-user");
}

describe("createLineWebhookMiddleware", () => {
  it("rejects startup when channel secret is missing", () => {
    expect(() =>
      startLineWebhook({
        channelSecret: "   ",
        onEvents: async () => {},
      }),
    ).toThrow(/requires a non-empty channel secret/i);
  });

  it.each([
    ["raw string body", JSON.stringify({ events: [{ type: "message" }] })],
    ["raw buffer body", Buffer.from(JSON.stringify({ events: [{ type: "follow" }] }), "utf-8")],
  ])("parses JSON from %s", async (_label, body) => {
    const { res, onEvents } = await invokeWebhook({ body });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(onEvents).toHaveBeenCalledWith(expect.objectContaining({ events: expect.any(Array) }));
  });

  it("rejects invalid JSON payloads", async () => {
    const { res, onEvents } = await invokeWebhook({ body: "not json" });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects webhooks with invalid signatures", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: { "x-line-signature": "invalid-signature" },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects verification-shaped requests without a signature", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [] }),
      headers: {},
      autoSign: false,
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-Line-Signature header" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects oversized signed payloads before JSON parsing", async () => {
    const largeBody = JSON.stringify({ events: [], payload: "x".repeat(70 * 1024) });
    const { res, onEvents } = await invokeWebhook({ body: largeBody });
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: "Payload too large" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: JSON.stringify({ events: [{ type: "message" }] }),
      headers: {},
      autoSign: false,
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-Line-Signature header" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("rejects signed requests when raw body is missing", async () => {
    const { res, onEvents } = await invokeWebhook({
      body: { events: [{ type: "message" }] },
      headers: { "x-line-signature": "signed" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing raw request body for signature verification",
    });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("uses the signed raw body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: JSON.stringify({
        events: [{ type: "message", source: { userId: "signed-user" } }],
      }),
      signedUserId: "signed-user",
    });
  });

  it("uses signed raw buffer body instead of a pre-parsed req.body object", async () => {
    await expectSignedRawBodyWins({
      rawBody: Buffer.from(
        JSON.stringify({
          events: [{ type: "message", source: { userId: "signed-buffer-user" } }],
        }),
        "utf-8",
      ),
      signedUserId: "signed-buffer-user",
    });
  });

  it("rejects invalid signed raw JSON even when req.body is a valid object", async () => {
    const onEvents = vi.fn(async (_body: WebhookRequestBody) => {});
    const rawBody = "not-json";
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
    });

    const req = {
      headers: { "x-line-signature": sign(rawBody, SECRET) },
      rawBody,
      body: { events: [{ type: "message" }] },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const res = createRes();

    // oxlint-disable-next-line typescript/no-explicit-any
    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid webhook payload" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("returns 500 when event processing fails and does not acknowledge with 200", async () => {
    const onEvents = vi.fn(async () => {
      throw new Error("boom");
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const middleware = createLineWebhookMiddleware({
      channelSecret: SECRET,
      onEvents,
      runtime,
    });

    const req = {
      headers: { "x-line-signature": sign(rawBody, SECRET) },
      body: rawBody,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const res = createRes();

    // oxlint-disable-next-line typescript/no-explicit-any
    await middleware(req, res, {} as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(runtime.error).toHaveBeenCalled();
  });
});
