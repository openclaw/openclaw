import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { createLineNodeWebhookHandler } from "./webhook-node.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

function createRes() {
  const headers: Record<string, string> = {};
  const resObj = {
    statusCode: 0,
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: vi.fn((data?: unknown) => {
      resObj.headersSent = true;
      // Keep payload available for assertions
      resObj.body = data;
    }),
    body: undefined as unknown,
  };
  const res = resObj as unknown as ServerResponse & { body?: unknown };
  return { res, headers };
}

const SECRET = "secret";

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function createPostWebhookTestHarness(rawBody: string, secret = "secret") {
  const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
  const runtime = createRuntimeSpies();
  const handler = createLineNodeWebhookHandler({
    getTargets: () => [{ channelSecret: secret, bot }],
    runtime,
    readBody: async () => rawBody,
  });
  return { bot, handler, secret };
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

const parseResponseBody = (body: unknown) => {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

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
  const { res, headers } = createRes();
  const req = Object.assign(createMockIncomingRequest([params.rawBody]), {
    method: "POST",
    headers: params.signed ? { "x-line-signature": sign(params.rawBody, SECRET) } : {},
    body: params.parsedBody,
  });
  await handler(req, res);
  return {
    body: parseResponseBody(res.body),
    contentType: headers["content-type"],
    dispatched,
    runtimeError: runtime.error,
    status: res.statusCode,
  };
}

describe("LINE webhook POST contract", () => {
  it("rejects verification-shaped requests without a signature", async () => {
    const result = await invokeNodePostContract({
      rawBody: JSON.stringify({ events: [] }),
      signed: false,
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Missing X-Line-Signature header" });
    expect(result.contentType).toBe("application/json");
    expect(result.dispatched).not.toHaveBeenCalled();
  });

  it("accepts signed verification-shaped requests without dispatching events", async () => {
    const result = await invokeNodePostContract({
      rawBody: JSON.stringify({ events: [] }),
      signed: true,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok" });
    expect(result.contentType).toBe("application/json");
    expect(result.dispatched).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const result = await invokeNodePostContract({
      rawBody: JSON.stringify({ events: [{ type: "message" }] }),
      signed: false,
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Missing X-Line-Signature header" });
    expect(result.dispatched).not.toHaveBeenCalled();
  });

  it("returns 500 when durable admission fails", async () => {
    const result = await invokeNodePostContract({
      failWith: new Error("persist failed"),
      rawBody: JSON.stringify({ events: [{ type: "message" }] }),
      signed: true,
    });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Internal server error" });
    expect(result.runtimeError).toHaveBeenCalledTimes(1);
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
    const runtimeMessage = String(firstMockCall(result.runtimeError, "runtime error")[0]);
    expect(runtimeMessage).toContain("line webhook error:");
    expect(runtimeMessage).toContain("LINE_ADMISSION_REJECTED");
    expect(runtimeMessage).toContain("retryAfterMs");
    expect(runtimeMessage).not.toContain("[object Object]");
  });
});

describe("createLineNodeWebhookHandler", () => {
  it("returns 200 for GET", async () => {
    const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
    const runtime = createRuntimeSpies();
    const handler = createLineNodeWebhookHandler({
      getTargets: () => [{ channelSecret: "secret", bot }],
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "GET", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("returns 204 for HEAD", async () => {
    const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
    const runtime = createRuntimeSpies();
    const handler = createLineNodeWebhookHandler({
      getTargets: () => [{ channelSecret: "secret", bot }],
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "HEAD", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it("returns 405 for non-GET/HEAD/POST methods", async () => {
    const { bot, handler } = createPostWebhookTestHarness(JSON.stringify({ events: [] }));

    const { res, headers } = createRes();
    await handler({ method: "PUT", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(405);
    expect(headers.allow).toBe("GET, HEAD, POST");
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects unsigned POST requests before reading the body", async () => {
    const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
    const runtime = createRuntimeSpies();
    const readBody = vi.fn(async () => JSON.stringify({ events: [{ type: "message" }] }));
    const handler = createLineNodeWebhookHandler({
      getTargets: () => [{ channelSecret: "secret", bot }],
      runtime,
      readBody,
    });

    const { res } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("uses strict pre-auth limits for signed POST requests", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const bot = { handleWebhook: vi.fn(async () => "durable" as const) };
    const runtime = createRuntimeSpies();
    const readBody = vi.fn(async (_req: IncomingMessage, maxBytes: number, timeoutMs?: number) => {
      expect(maxBytes).toBe(64 * 1024);
      expect(timeoutMs).toBe(5_000);
      return rawBody;
    });
    const handler = createLineNodeWebhookHandler({
      getTargets: () => [{ channelSecret: "secret", bot }],
      runtime,
      readBody,
      maxBodyBytes: 1024 * 1024,
    });

    const { res } = createRes();
    await runSignedPost({ handler, rawBody, secret: "secret", res });

    expect(res.statusCode).toBe(200);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(bot.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid signatures before parsing the body", async () => {
    const rawBody = "not json";
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
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

    const { res } = createRes();
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
