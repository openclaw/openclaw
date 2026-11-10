import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import * as webhookGuards from "openclaw/plugin-sdk/webhook-request-guards";
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => vi.restoreAllMocks());
function createPostWebhookTestHarness() {
  const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
  const runtime = createRuntimeSpies();
  const handler = createLineNodeWebhookHandler({
    getTargets: () => [{ channelSecret: SECRET, bot }],
    runtime,
  });
  return { bot, handler };
}
const runSignedPost = async (params: {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  rawBody: string;
  secret: string;
  res: ServerResponse;
}) =>
  await params.handler(
    Object.assign(createMockIncomingRequest([params.rawBody]), {
      method: "POST",
      headers: { "x-line-signature": sign(params.rawBody, params.secret) },
    }),
    params.res,
  );
async function invokeNodePostContract(params: { rawBody: string; parsedBody?: unknown }) {
  const dispatched = vi.fn(async () => "durable" as const);
  const runtime = createRuntimeSpies();
  const handler = createLineNodeWebhookHandler({
    getTargets: () => [{ channelSecret: SECRET, bot: { handleWebhook: dispatched } }],
    runtime,
  });
  const res = createRes();
  const req = Object.assign(createMockIncomingRequest([params.rawBody]), {
    method: "POST",
    headers: { "x-line-signature": sign(params.rawBody, SECRET) },
    body: params.parsedBody,
  });
  await handler(req, res);
  return {
    body: res.body === undefined ? undefined : (JSON.parse(res.body) as unknown),
    dispatched,
    status: res.statusCode,
  };
}
describe("createLineNodeWebhookHandler", () => {
  it.each([
    { method: "GET", statusCode: 200, body: "OK" },
    { method: "HEAD", statusCode: 204, body: undefined },
  ])("returns $statusCode for $method", async ({ method, statusCode, body }) => {
    const { handler } = createPostWebhookTestHarness();
    const res = createRes();
    await handler({ method, headers: {} } as IncomingMessage, res);
    expect(res).toMatchObject({ statusCode, body });
  });
  it("returns 405 for non-GET/HEAD/POST methods", async () => {
    const { bot, handler } = createPostWebhookTestHarness();
    const res = createRes();
    await handler({ method: "PUT", headers: {} } as unknown as IncomingMessage, res);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET, HEAD, POST");
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
  it("rejects unsigned POST requests before reading the body", async () => {
    const readBody = vi.spyOn(webhookGuards, "readRequestBodyWithLimit");
    const { bot, handler } = createPostWebhookTestHarness();
    const res = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);
    expect(res.statusCode).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
  it("uses strict pre-auth limits for signed POST requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const readBody = vi.spyOn(webhookGuards, "readRequestBodyWithLimit");
    const { bot, handler } = createPostWebhookTestHarness();
    const res = createRes();
    await runSignedPost({ handler, rawBody, secret: "secret", res });
    expect(res.statusCode).toBe(200);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(readBody).toHaveBeenCalledWith(expect.anything(), {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      destroyOnLimit: false,
    });
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid signatures before parsing the body", async () => {
    const rawBody = "not json";
    const { bot, handler } = createPostWebhookTestHarness();
    const res = createRes();
    await handler(
      Object.assign(createMockIncomingRequest([rawBody]), {
        method: "POST",
        headers: { "x-line-signature": "bad" },
      }),
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
      parsedBody: { events: [{ type: "message", source: { userId: "tampered-user" } }] },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok" });
    expect(result.dispatched).toHaveBeenCalledExactlyOnceWith({
      events: [{ type: "message", source: { userId: "signed-user" } }],
    });
  });
  it("rejects invalid signed JSON even when a pre-parsed body is valid", async () => {
    const result = await invokeNodePostContract({
      rawBody: "not json",
      parsedBody: { events: [{ type: "message" }] },
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid webhook payload" });
    expect(result.dispatched).not.toHaveBeenCalled();
  });
});
