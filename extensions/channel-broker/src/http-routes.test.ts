import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BROKER_PROTOCOL_VERSION } from "openclaw/plugin-sdk/channel-broker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleChannelBrokerInboundHttpRequest,
  registerChannelBrokerHttpRoutes,
} from "./http-routes.js";
import { resetChannelBrokerRuntimeForTest, setChannelBrokerRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type MockResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

function createRequest(params: {
  body: string;
  signature?: string;
  method?: string;
}): IncomingMessage {
  const req = Readable.from([params.body]) as IncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = {
    "content-type": "application/json",
    ...(params.signature ? { "x-openclaw-broker-signature": params.signature } : {}),
  };
  return req;
}

function createResponse(): MockResponse {
  const res: {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
    setHeader(name: string, value: string): unknown;
    end(chunk?: unknown): unknown;
  } = {
    statusCode: 200,
    body: "",
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk == null ? "" : String(chunk);
      return this;
    },
  };
  return res as MockResponse;
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function brokerConfig(secret = "broker-secret"): CoreConfig {
  return {
    channels: {
      "channel-broker": {
        accounts: {
          acme: {
            enabled: true,
            baseUrl: "https://broker.example.test",
            signingSecret: secret,
            allowFrom: ["user-1"],
          },
        },
      },
    },
  };
}

function inboundBody(senderId = "user-1"): string {
  return JSON.stringify({
    version: BROKER_PROTOCOL_VERSION,
    eventId: "evt-1",
    providerId: "acme",
    platform: "Telegram",
    accountId: "bot-main",
    conversation: { id: "-100123", type: "thread", threadId: "77" },
    sender: { id: senderId, handle: "lume" },
    message: { id: "101", text: "/verbose status" },
  });
}

describe("channel-broker HTTP routes", () => {
  beforeEach(() => {
    resetChannelBrokerRuntimeForTest();
  });

  it("registers the signed inbound webhook route", () => {
    const registerHttpRoute = vi.fn();

    registerChannelBrokerHttpRoutes({
      config: brokerConfig(),
      registerHttpRoute,
    } as never);

    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/v1/channel-broker/inbound",
        auth: "plugin",
        match: "exact",
        handler: expect.any(Function),
      }),
    );
  });

  it("verifies signatures, normalizes events, and delegates durable receive ack", async () => {
    const body = inboundBody();
    const receiveInboundEvent = vi.fn(async () => ({ status: "accepted" as const }));
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig(),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: "accepted",
      dedupeKey: "acme:bot-main:telegram:evt-1",
    });
    expect(receiveInboundEvent).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      event: expect.objectContaining({
        providerId: "acme",
        platform: "telegram",
        message: { id: "101", text: "/verbose status" },
      }),
      dedupeKey: "acme:bot-main:telegram:evt-1",
      ackPolicy: "after_durable_send",
    });
  });

  it("rejects inbound events with invalid signatures before runtime dispatch", async () => {
    const body = inboundBody();
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig(),
      req: createRequest({ body, signature: sign(body, "wrong-secret") }),
      res,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "invalid_signature" });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("enforces configured broker sender allowlists before runtime dispatch", async () => {
    const body = inboundBody("blocked-user");
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig(),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "sender_not_allowed" });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });
});
