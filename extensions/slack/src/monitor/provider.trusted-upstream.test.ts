import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { __testing } from "./provider.js";

function createRequest(params: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
}): IncomingMessage {
  const rawBody =
    params.body === undefined
      ? ""
      : typeof params.body === "string"
        ? params.body
        : JSON.stringify(params.body);
  const req = Readable.from([rawBody]) as IncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = {};
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    req.headers[key.toLowerCase()] = value;
  }
  return req;
}

function createResponse(): ServerResponse & { body: string; headers: Record<string, string> } {
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        this.body += chunk;
      }
      return this;
    },
  };
  return res as ServerResponse & { body: string; headers: Record<string, string> };
}

function createEnvelope(
  type: "events_api" | "slash_commands" | "interactive" = "events_api",
  eventTime = Math.floor(Date.now() / 1000),
) {
  return {
    type,
    envelope_id: "evt-1",
    payload: {
      event_time: eventTime,
      event: { type: "app_mention", user: "U123", text: "hi" },
    },
  };
}

describe("trusted-upstream Slack handler", () => {
  const requireHeader = { name: "X-OpenClaw-Trusted-Upstream-Verified", value: "true" };

  it("rejects requests without the required header", async () => {
    const processEvent = vi.fn();
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent },
      requireHeader,
    });
    const res = createResponse();

    await handler(createRequest({ body: createEnvelope() }), res);

    expect(res.statusCode).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent: vi.fn() },
      requireHeader,
    });
    const res = createResponse();

    await handler(
      createRequest({ body: "{", headers: { "X-OpenClaw-Trusted-Upstream-Verified": "true" } }),
      res,
    );

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid envelope shapes", async () => {
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent: vi.fn() },
      requireHeader,
    });
    const res = createResponse();

    await handler(
      createRequest({
        body: { type: "unknown", payload: {} },
        headers: { "X-OpenClaw-Trusted-Upstream-Verified": "true" },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
  });

  it("rejects stale event_time", async () => {
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent: vi.fn() },
      requireHeader,
      maxEventAgeSeconds: 300,
    });
    const res = createResponse();

    await handler(
      createRequest({
        body: createEnvelope("events_api", Math.floor(Date.now() / 1000) - 301),
        headers: { "X-OpenClaw-Trusted-Upstream-Verified": "true" },
      }),
      res,
    );

    expect(res.statusCode).toBe(422);
    expect(res.body).toBe("event_time stale");
  });

  it("passes accepted envelopes to Bolt processEvent", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent },
      requireHeader,
      maxEventAgeSeconds: 300,
    });
    const envelope = createEnvelope();
    const res = createResponse();

    await handler(
      createRequest({
        body: envelope,
        headers: { "X-OpenClaw-Trusted-Upstream-Verified": "true" },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(processEvent).toHaveBeenCalledWith({
      body: envelope.payload,
      ack: expect.any(Function),
      customProperties: {},
    });
  });

  it.each(["slash_commands", "interactive"] as const)("accepts %s envelopes", async (type) => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent },
      requireHeader,
      maxEventAgeSeconds: 300,
    });
    const envelope = createEnvelope(type);
    const res = createResponse();

    await handler(
      createRequest({
        body: envelope,
        headers: { "X-OpenClaw-Trusted-Upstream-Verified": "true" },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        body: envelope.payload,
      }),
    );
  });

  it("allows ancient event_time when maxEventAgeSeconds is disabled", async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const handler = __testing.createSlackTrustedUpstreamHttpHandler({
      app: { processEvent },
      requireHeader,
      maxEventAgeSeconds: 0,
    });
    const res = createResponse();

    await handler(
      createRequest({
        body: createEnvelope("events_api", 1),
        headers: { "X-OpenClaw-Trusted-Upstream-Verified": "true" },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(processEvent).toHaveBeenCalledOnce();
  });
});
