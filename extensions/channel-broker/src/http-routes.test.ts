import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BROKER_PROTOCOL_VERSION } from "openclaw/plugin-sdk/channel-broker";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
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
      this.body += typeof chunk === "string" ? chunk : chunk == null ? "" : JSON.stringify(chunk);
      return this;
    },
  };
  return res as MockResponse;
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function brokerConfig(
  secret = "broker-secret",
  overrides: Record<string, unknown> = {},
): CoreConfig {
  return {
    channels: {
      "channel-broker": {
        accounts: {
          acme: {
            enabled: true,
            baseUrl: "https://broker.example.test",
            signingSecret: secret,
            allowFrom: ["user-1"],
            ...overrides,
          },
        },
      },
    },
  };
}

function inboundBody(senderId = "user-1", overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: BROKER_PROTOCOL_VERSION,
    eventId: "evt-1",
    providerId: "acme",
    platform: "Telegram",
    accountId: "bot-main",
    conversation: { id: "-100123", type: "thread", threadId: "77" },
    sender: { id: senderId, handle: "lume" },
    message: { id: "101", text: "/verbose status" },
    ...overrides,
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

  it("adapts the injected plugin runtime into the real channel turn path", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "main",
      accountId: "acme",
      sessionKey: "agent:main:channel-broker:telegram:-100123",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
      channel: "channel-broker",
    }));
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      channel: {
        routing: {
          resolveAgentRoute,
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "channel-broker",
        accountId: "acme",
        peer: { kind: "channel", id: "telegram:-100123" },
        parentPeer: { kind: "channel", id: "telegram:-100123" },
      }),
    );
    expect(pluginRuntime.channel.turn.run).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "channel-broker",
        accountId: "acme",
        raw: expect.objectContaining({ eventId: "evt-1", platform: "telegram" }),
      }),
    );
    expect(pluginRuntime.channel.turn.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "channel-broker",
        accountId: "acme",
        surface: "telegram",
        messageId: "101",
        messageIdFull: "evt-1",
        reply: expect.objectContaining({
          to: "telegram:-100123?conversationType=thread&threadId=77",
          originatingTo: "telegram:-100123?conversationType=thread&threadId=77",
        }),
        message: expect.objectContaining({
          rawBody: "/verbose status",
          bodyForAgent: "/verbose status",
          commandBody: "/verbose status",
        }),
      }),
    );
    expect(pluginRuntime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/sessions.json",
        sessionKey: "agent:main:channel-broker:telegram:-100123",
        ctx: expect.objectContaining({
          To: "telegram:-100123?conversationType=thread&threadId=77",
          BrokerProviderId: "acme",
          BrokerPlatform: "telegram",
        }),
      }),
    );
    expect(
      pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          OriginatingChannel: "channel-broker",
          Surface: "telegram",
        }),
      }),
    );
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

  it("rejects unlisted inbound provider ids before inheriting top-level credentials", async () => {
    const body = inboundBody("user-1", { providerId: "rogue-provider" });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: {
        channels: {
          "channel-broker": {
            baseUrl: "https://broker.example.test",
            signingSecret: "broker-secret",
            allowFrom: ["user-1"],
          },
        },
      },
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "provider_not_configured" });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("applies the pre-auth body limit before signature verification", async () => {
    const body = inboundBody("user-1", { message: { id: "101", text: "x".repeat(70 * 1024) } });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig(),
      req: createRequest({ body, signature: sign(body, "wrong-secret") }),
      res,
    });

    expect(res.statusCode).toBe(413);
    expect(res.body).toBe("Payload too large");
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

  it("fails closed when no inbound sender allowlist is configured", async () => {
    const body = inboundBody();
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", { allowFrom: undefined }),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "sender_not_allowed" });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects signed inbound events for platforms outside the provider account", async () => {
    const body = inboundBody("user-1", { platform: "Slack" });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", { platforms: ["telegram"] }),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "unsupported_platform" });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("applies platform aliases before inbound platform allowlists and dedupe", async () => {
    const body = inboundBody("user-1", { platform: "tg" });
    const receiveInboundEvent = vi.fn(async () => ({ status: "accepted" as const }));
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", {
        platforms: ["telegram"],
        platformAliases: { tg: "telegram" },
      }),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      dedupeKey: "acme:bot-main:telegram:evt-1",
    });
    expect(receiveInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ platform: "telegram" }),
        dedupeKey: "acme:bot-main:telegram:evt-1",
      }),
    );
  });

  it("rejects signed inbound events for a mismatched configured native account id", async () => {
    const body = inboundBody("user-1", { accountId: "bot-other" });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", { accountId: "bot-main" }),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "account_id_mismatch" });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });
});
