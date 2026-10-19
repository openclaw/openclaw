import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { createLineNodeWebhookHandler } from "./webhook-node.js";
const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");
function createRes() {
  const res = createMockServerResponse();
  res.statusCode = 0;
  return res;
}
const SECRET = "secret";
function createPostWebhookTestHarness(
  rawBody: string,
  readBody: NonNullable<Parameters<typeof createLineNodeWebhookHandler>[0]["readBody"]> = vi.fn(
    async () => rawBody,
  ),
) {
  const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
  const runtime = createRuntimeSpies();
  const handler = createLineNodeWebhookHandler({
    getTargets: () => [{ channelSecret: SECRET, bot }],
    runtime,
    readBody,
  });
  return { bot, handler, readBody };
}
const runSignedPost = async (params: {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  rawBody: string;
  secret: string;
  res: ServerResponse;
}) =>
  await params.handler(
    {
      method: "POST",
      headers: { "x-line-signature": sign(params.rawBody, params.secret) },
    } as unknown as IncomingMessage,
    params.res,
  );
async function invokeNodePostContract(params: {
  failWith?: unknown;
  rawBody: string;
  signed: boolean;
  parsedBody?: unknown;
}) {
  const dispatched = vi.fn(async () => {
    if (params.failWith) {
      // oxlint-disable-next-line typescript/only-throw-error -- Webhook boundaries must report non-Error throws from downstream dispatchers.
      throw params.failWith;
    }
    return "durable" as const;
  });
  const runtime = createRuntimeSpies();
  const handler = createLineNodeWebhookHandler({
    getTargets: () => [{ channelSecret: SECRET, bot: { handleWebhook: dispatched } }],
    runtime,
  });
  const res = createRes();
  const req = Object.assign(createMockIncomingRequest([params.rawBody]), {
    method: "POST",
    headers: params.signed ? { "x-line-signature": sign(params.rawBody, SECRET) } : {},
    body: params.parsedBody,
  });
  await handler(req, res);
  return {
    body: res.body === undefined ? undefined : (JSON.parse(res.body) as unknown),
    contentType: res.getHeader("content-type"),
    dispatched,
    runtimeError: runtime.error,
    status: res.statusCode,
  };
}
describe("LINE webhook POST contract", () => {
  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const result = await invokeNodePostContract({
      rawBody: JSON.stringify({ events: [] }),
      signed: true,
    });
    expect(result).toMatchObject({
      status: 200,
      body: { status: "ok" },
      contentType: "application/json",
    });
    expect(result.dispatched).not.toHaveBeenCalled();
  });
  it("reports non-Error admission failures without object Object", async () => {
    const result = await invokeNodePostContract({
      failWith: { code: "LINE_ADMISSION_REJECTED", retryAfterMs: 250 },
      rawBody: JSON.stringify({ events: [{ type: "message" }] }),
      signed: true,
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Internal server error" });
    expect(result.runtimeError).toHaveBeenCalledTimes(1);
    const runtimeMessage = String(result.runtimeError.mock.calls[0]?.[0]);
    expect(runtimeMessage).toContain("line webhook error:");
    expect(runtimeMessage).toContain("LINE_ADMISSION_REJECTED");
    expect(runtimeMessage).toContain("retryAfterMs");
    expect(runtimeMessage).not.toContain("[object Object]");
  });
});
describe("createLineNodeWebhookHandler", () => {
  it.each([
    { method: "GET", statusCode: 200, body: "OK" },
    { method: "HEAD", statusCode: 204, body: undefined },
  ])("returns $statusCode for $method", async ({ method, statusCode, body }) => {
    const { handler } = createPostWebhookTestHarness("");
    const res = createRes();
    await handler({ method, headers: {} } as IncomingMessage, res);
    expect(res).toMatchObject({ statusCode, body });
  });
  it("returns 405 for non-GET/HEAD/POST methods", async () => {
    const { bot, handler } = createPostWebhookTestHarness(JSON.stringify({ events: [] }));
    const res = createRes();
    await handler({ method: "PUT", headers: {} } as unknown as IncomingMessage, res);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET, HEAD, POST");
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
  it("rejects unsigned POST requests before reading the body", async () => {
    const { bot, handler, readBody } = createPostWebhookTestHarness(
      JSON.stringify({ events: [{ type: "message" }] }),
    );
    const res = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);
    expect(res.statusCode).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
  it("uses strict pre-auth limits for signed POST requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const readBody = vi.fn(async (_req: IncomingMessage, maxBytes: number, timeoutMs?: number) => {
      expect(maxBytes).toBe(64 * 1024);
      expect(timeoutMs).toBe(5_000);
      return rawBody;
    });
    const { bot, handler } = createPostWebhookTestHarness(rawBody, readBody);
    const res = createRes();
    await runSignedPost({ handler, rawBody, secret: "secret", res });
    expect(res.statusCode).toBe(200);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid signatures before parsing the body", async () => {
    const rawBody = "not json";
    const { bot, handler } = createPostWebhookTestHarness(rawBody);
    const res = createRes();
    await handler(
      { method: "POST", headers: { "x-line-signature": "bad" } } as unknown as IncomingMessage,
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
  it("dispatches signed request bytes instead of a pre-parsed body", async () => {
    const result = await invokeNodePostContract({
      rawBody: JSON.stringify({
        events: [{ type: "message", source: { userId: "signed-user" } }],
      }),
      signed: true,
      parsedBody: { events: [{ type: "message", source: { userId: "tampered-user" } }] },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok" });
    expect(result.dispatched).toHaveBeenCalledExactlyOnceWith({
      events: [{ type: "message", source: { userId: "signed-user" } }],
    });
  });
  it("waits for durable admission before acknowledging signed event requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const admitted = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<"durable">();
    const bot = {
      handleWebhook: vi.fn(async () => {
        admitted.resolve();
        return delivery.promise;
      }),
    };
    const runtime = createRuntimeSpies();
    const handler = createLineNodeWebhookHandler({
      getTargets: () => [{ channelSecret: SECRET, bot }],
      runtime,
      readBody: async () => rawBody,
    });
    const res = createRes();
    const request = runSignedPost({ handler, rawBody, secret: SECRET, res });
    await admitted.promise;
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
    expect(res.headersSent).toBe(false);
    delivery.resolve("durable");
    await request;
    expect(res.statusCode).toBe(200);
    expect(res.headersSent).toBe(true);
  });
  it("rejects invalid signed JSON even when a pre-parsed body is valid", async () => {
    const result = await invokeNodePostContract({
      rawBody: "not json",
      signed: true,
      parsedBody: { events: [{ type: "message" }] },
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid webhook payload" });
    expect(result.dispatched).not.toHaveBeenCalled();
  });
});
