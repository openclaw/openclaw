import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { BrokerInboundEventV1 } from "openclaw/plugin-sdk/channel-broker";
import { BROKER_PROTOCOL_VERSION, createBrokerReceipt } from "openclaw/plugin-sdk/channel-broker";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChannelBrokerAccount } from "./accounts.js";
import {
  handleChannelBrokerInboundHttpRequest,
  registerChannelBrokerHttpRoutes,
} from "./http-routes.js";
import {
  receiveBrokerInboundEvent,
  resetChannelBrokerRuntimeForTest,
  setChannelBrokerRuntime,
} from "./runtime.js";
import type { CoreConfig } from "./types.js";

type MockResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

type OpenKeyedStoreMock = ReturnType<typeof createPluginRuntimeMock>["state"]["openKeyedStore"] & {
  callCount(): number;
  ageRecords(ms: number): void;
};

const TEST_SIGNATURE_TIMESTAMP = Date.now();

function createRequest(params: {
  body: string;
  signature?: string;
  timestamp?: number | string;
  method?: string;
}): IncomingMessage {
  const req = Readable.from([params.body]) as IncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = {
    "content-type": "application/json",
    "x-openclaw-broker-timestamp": String(params.timestamp ?? TEST_SIGNATURE_TIMESTAMP),
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

function sign(
  body: string,
  secret: string,
  timestamp: number | string = TEST_SIGNATURE_TIMESTAMP,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function createMemoryKeyedStore<T>() {
  const values = new Map<string, { key: string; value: T; createdAt: number }>();
  return {
    async register(key: string, value: T): Promise<void> {
      values.set(key, { key, value, createdAt: 1 });
    },
    async registerIfAbsent(key: string, value: T): Promise<boolean> {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: 1 });
      return true;
    },
    async lookup(key: string): Promise<T | undefined> {
      return values.get(key)?.value;
    },
    async consume(key: string): Promise<T | undefined> {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key: string): Promise<boolean> {
      return values.delete(key);
    },
    async entries(): Promise<Array<{ key: string; value: T; createdAt: number }>> {
      return Array.from(values.values());
    },
    async clear(): Promise<void> {
      values.clear();
    },
    ageRecords(ms: number): void {
      for (const entry of values.values()) {
        const record = entry.value;
        if (
          record &&
          typeof record === "object" &&
          "updatedAt" in record &&
          typeof record.updatedAt === "number"
        ) {
          record.updatedAt -= ms;
        }
      }
    },
  };
}

function createOpenKeyedStoreMock(): OpenKeyedStoreMock {
  const stores = new Map<string, ReturnType<typeof createMemoryKeyedStore<unknown>>>();
  const calls: string[] = [];
  const openKeyedStore = (<T>(
    options: Parameters<ReturnType<typeof createPluginRuntimeMock>["state"]["openKeyedStore"]>[0],
  ) => {
    const namespace = options.namespace;
    calls.push(namespace);
    let store = stores.get(namespace);
    if (!store) {
      store = createMemoryKeyedStore();
      stores.set(namespace, store);
    }
    return store as ReturnType<typeof createMemoryKeyedStore<T>>;
  }) as unknown as OpenKeyedStoreMock;
  openKeyedStore.callCount = () => calls.length;
  openKeyedStore.ageRecords = (ms) => {
    for (const store of stores.values()) {
      store.ageRecords(ms);
    }
  };
  return openKeyedStore;
}

function createMemoryKeyedStore<T>() {
  const values = new Map<string, { key: string; value: T; createdAt: number }>();
  return {
    async register(key: string, value: T): Promise<void> {
      values.set(key, { key, value, createdAt: 1 });
    },
    async registerIfAbsent(key: string, value: T): Promise<boolean> {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: 1 });
      return true;
    },
    async lookup(key: string): Promise<T | undefined> {
      return values.get(key)?.value;
    },
    async consume(key: string): Promise<T | undefined> {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key: string): Promise<boolean> {
      return values.delete(key);
    },
    async entries(): Promise<Array<{ key: string; value: T; createdAt: number }>> {
      return Array.from(values.values());
    },
    async clear(): Promise<void> {
      values.clear();
    },
  };
}

function createOpenKeyedStoreMock() {
  const stores = new Map<string, ReturnType<typeof createMemoryKeyedStore<unknown>>>();
  const openKeyedStore: PluginRuntime["state"]["openKeyedStore"] = <T>({ namespace }) => {
    let store = stores.get(namespace);
    if (!store) {
      store = createMemoryKeyedStore();
      stores.set(namespace, store);
    }
    return store as ReturnType<typeof createMemoryKeyedStore<T>>;
  };
  return vi.fn(openKeyedStore);
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

function inboundEvent(overrides: Record<string, unknown> = {}): BrokerInboundEventV1 {
  return JSON.parse(inboundBody("user-1", { platform: "telegram", ...overrides }));
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
    const body = inboundBody("user-1", { providerId: "ACME" });
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

  it("keeps thread routing scoped when providers report channel conversations with thread ids", async () => {
    const body = inboundBody("user-1", {
      conversation: { id: "-100123", type: "channel", threadId: "77" },
    });
    const config = brokerConfig();
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "main",
      accountId: "acme",
      sessionKey: "agent:main:channel-broker:telegram:-100123:thread:77",
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
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    setChannelBrokerRuntime(pluginRuntime);
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "channel", id: "telegram:-100123:thread:77" },
        parentPeer: { kind: "channel", id: "telegram:-100123" },
      }),
    );
  });

  it("skips unmentioned ambient group broker messages before dispatch", async () => {
    const body = inboundBody("user-1", {
      message: { id: "101", text: "ambient hello" },
    });
    const config = brokerConfig("broker-secret", { allowFrom: ["*"] });
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    setChannelBrokerRuntime(pluginRuntime);
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: "rejected",
      message: "activation_skipped",
    });
    expect(
      pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).not.toHaveBeenCalled();
  });

  it("ignores malformed broker mention booleans before group activation", async () => {
    const body = inboundBody("user-1", {
      message: {
        id: "101",
        text: "ambient hello",
        mentions: { canDetectMention: "true", wasMentioned: "true", hasAnyMention: "true" },
      },
    });
    const config = brokerConfig("broker-secret", { allowFrom: ["*"] });
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    setChannelBrokerRuntime(pluginRuntime);
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: "rejected",
      message: "activation_skipped",
    });
    expect(
      pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).not.toHaveBeenCalled();
  });

  it("dispatches mentioned group broker messages with mention access facts", async () => {
    const body = inboundBody("user-1", {
      message: {
        id: "101",
        text: "hello there",
        mentions: { canDetectMention: true, wasMentioned: true, hasAnyMention: true },
      },
    });
    const config = brokerConfig("broker-secret", { allowFrom: ["*"] });
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    setChannelBrokerRuntime(pluginRuntime);
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(pluginRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          group: expect.objectContaining({ requireMention: true, senderAllowed: true }),
          mentions: expect.objectContaining({
            canDetectMention: true,
            wasMentioned: true,
            effectiveWasMentioned: true,
            shouldSkip: false,
          }),
        }),
      }),
    );
  });

  it("dispatches broker senders matched by access groups", async () => {
    const body = inboundBody("user-1", {
      message: {
        id: "101",
        text: "hello there",
        mentions: { canDetectMention: true, wasMentioned: true, hasAnyMention: true },
      },
    });
    const config = {
      ...brokerConfig("broker-secret", { allowFrom: ["accessGroup:owners"] }),
      accessGroups: {
        owners: {
          type: "message.senders" as const,
          members: { "channel-broker": ["telegram:user-1"] },
        },
      },
    };
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
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
    expect(pluginRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          group: expect.objectContaining({ senderAllowed: true }),
        }),
      }),
    );
  });

  it("dispatches broker senders matched by platform-scoped allowlists", async () => {
    const body = inboundBody("user-1", {
      message: {
        id: "101",
        text: "hello there",
        mentions: { canDetectMention: true, wasMentioned: true, hasAnyMention: true },
      },
    });
    const config = brokerConfig("broker-secret", { allowFrom: ["telegram:user-1"] });
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
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
    expect(pluginRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          group: expect.objectContaining({ senderAllowed: true }),
        }),
      }),
    );
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
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      channel: {
        routing: {
          resolveAgentRoute,
        },
      },
      state: { openKeyedStore },
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
        peer: { kind: "channel", id: "telegram:-100123:thread:77" },
        parentPeer: { kind: "channel", id: "telegram:-100123" },
      }),
    );
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "channel-broker",
        accountId: "acme",
        raw: expect.objectContaining({ eventId: "evt-1", platform: "telegram" }),
      }),
    );
    expect(pluginRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "channel-broker",
        accountId: "acme",
        surface: "telegram",
        messageId: "101",
        messageIdFull: "evt-1",
        reply: expect.objectContaining({
          to: "broker:telegram:-100123?conversationType=thread&threadId=77",
          originatingTo: "broker:telegram:-100123?conversationType=thread&threadId=77",
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
          To: "broker:telegram:-100123?conversationType=thread&threadId=77",
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
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
  });

  it("deduplicates broker webhook redeliveries before dispatching another turn", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore },
    });
    setChannelBrokerRuntime(pluginRuntime);

    const first = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: first,
    });
    const second = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: second,
    });

    expect(first.statusCode).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(pluginRuntime.channel.turn.run).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable response for redelivery while durable send is still pending", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore },
    });
    let rejectFirstTurn!: (error: Error) => void;
    vi.mocked(pluginRuntime.channel.turn.run).mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectFirstTurn = reject;
        }),
    );
    setChannelBrokerRuntime(pluginRuntime);

    const first = handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: createResponse(),
    });
    await vi.waitFor(() => expect(pluginRuntime.channel.turn.run).toHaveBeenCalledTimes(1));

    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(425);
    expect(JSON.parse(redelivery.body)).toMatchObject({
      ok: false,
      status: "pending",
      message: "delivery pending",
    });
    expect(pluginRuntime.channel.turn.run).toHaveBeenCalledTimes(1);

    rejectFirstTurn(new Error("stop first turn"));
    await expect(first).rejects.toThrow("stop first turn");
  });

  it("allows provider redelivery after a failed broker webhook dispatch", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore },
    });
    vi.mocked(pluginRuntime.channel.turn.run).mockRejectedValueOnce(new Error("transient"));
    setChannelBrokerRuntime(pluginRuntime);

    await expect(
      handleChannelBrokerInboundHttpRequest({
        cfg: config,
        req: createRequest({ body, signature: sign(body, "broker-secret") }),
        res: createResponse(),
      }),
    ).rejects.toThrow("transient");

    const retry = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: retry,
    });

    expect(retry.statusCode).toBe(202);
    expect(JSON.parse(retry.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(pluginRuntime.channel.turn.run).toHaveBeenCalledTimes(2);
  });

  it("routes inbound progress and final deliveries through broker previews", async () => {
    const body = inboundBody();
    const config = brokerConfig("broker-secret", {
      capabilities: {
        telegram: {
          delivery: {
            text: true,
            thread: true,
            progressUpdates: true,
            previewFinalization: true,
          },
        },
      },
    });
    const sendOutboundRequest = vi.fn(async ({ request }) =>
      createBrokerReceipt({
        requestId: request.requestId,
        providerId: "acme",
        platform: request.platform,
        status: "sent",
        messageIds: ["preview-1"],
        ...(request.mode === "preview_update" ? { editToken: "edit-preview-1" } : {}),
      }),
    );
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "working" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            return {
              queuedFinal: false,
              counts: { tool: 1, block: 0, final: 1 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-preview-1",
      sendOutboundRequest,
    });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(sendOutboundRequest).toHaveBeenNthCalledWith(1, {
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        mode: "preview_update",
        payloads: [{ text: "working" }],
        requirements: { text: true, thread: true, progressUpdates: true },
      }),
    });
    expect(sendOutboundRequest).toHaveBeenNthCalledWith(2, {
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        mode: "finalize_preview",
        payloads: [{ text: "done" }],
        preview: {
          primaryMessageId: "preview-1",
          messageIds: ["preview-1"],
          editToken: "edit-preview-1",
        },
        requirements: { text: true, thread: true, previewFinalization: true },
      }),
    });
  });

  it("suppresses non-final preview updates when the provider does not support progress", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const sendOutboundRequest = vi.fn();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "working" }, { kind: "tool" });
            return {
              queuedFinal: false,
              counts: { tool: 1, block: 0, final: 0 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-preview-1",
      sendOutboundRequest,
    });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(sendOutboundRequest).not.toHaveBeenCalled();
  });

  it("falls back to normal final delivery when preview finalization fails", async () => {
    const body = inboundBody();
    const config = brokerConfig("broker-secret", {
      capabilities: {
        telegram: {
          delivery: {
            text: true,
            thread: true,
            progressUpdates: true,
            previewFinalization: true,
          },
        },
      },
    });
    const sendOutboundRequest = vi
      .fn()
      .mockImplementationOnce(async ({ request }) =>
        createBrokerReceipt({
          requestId: request.requestId,
          providerId: "acme",
          platform: request.platform,
          status: "sent",
          messageIds: ["preview-1"],
          editToken: "edit-preview-1",
        }),
      )
      .mockRejectedValueOnce(new Error("finalize failed"))
      .mockImplementationOnce(async ({ request }) =>
        createBrokerReceipt({
          requestId: request.requestId,
          providerId: "acme",
          platform: request.platform,
          status: "sent",
          messageIds: ["final-1"],
        }),
      );
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "working" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            return {
              queuedFinal: false,
              counts: { tool: 1, block: 0, final: 1 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-preview-1",
      sendOutboundRequest,
    });

    const res = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
    expect(sendOutboundRequest).toHaveBeenNthCalledWith(1, {
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({ mode: "preview_update" }),
    });
    expect(sendOutboundRequest).toHaveBeenNthCalledWith(2, {
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        mode: "finalize_preview",
        preview: {
          primaryMessageId: "preview-1",
          messageIds: ["preview-1"],
          editToken: "edit-preview-1",
        },
      }),
    });
    expect(sendOutboundRequest).toHaveBeenNthCalledWith(3, {
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({ mode: "final", payloads: [{ text: "done" }] }),
    });
  });

  it("does not fallback after visible preview finalization failures", async () => {
    const body = inboundBody();
    const config = brokerConfig("broker-secret", {
      capabilities: {
        telegram: {
          delivery: {
            text: true,
            thread: true,
            progressUpdates: true,
            previewFinalization: true,
          },
        },
      },
    });
    const visibleFinalizeError = Object.assign(new Error("visible finalize failed"), {
      visibleReplySent: true,
    });
    const sendOutboundRequest = vi
      .fn()
      .mockImplementationOnce(async ({ request }) =>
        createBrokerReceipt({
          requestId: request.requestId,
          providerId: "acme",
          platform: request.platform,
          status: "sent",
          messageIds: ["preview-1"],
        }),
      )
      .mockRejectedValueOnce(visibleFinalizeError);
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "working" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            return {
              queuedFinal: false,
              counts: { tool: 1, block: 0, final: 1 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-preview-1",
      sendOutboundRequest,
    });

    await expect(
      handleChannelBrokerInboundHttpRequest({
        cfg: config,
        req: createRequest({ body, signature: sign(body, "broker-secret") }),
        res: createResponse(),
      }),
    ).rejects.toThrow("visible finalize failed");

    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(200);
    expect(JSON.parse(redelivery.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(sendOutboundRequest).toHaveBeenCalledTimes(2);
  });

  it("deduplicates redelivery after partial visible preview delivery failures", async () => {
    const body = inboundBody();
    const config = brokerConfig("broker-secret", {
      capabilities: {
        telegram: {
          delivery: {
            text: true,
            thread: true,
            progressUpdates: true,
          },
        },
      },
    });
    const sendOutboundRequest = vi
      .fn()
      .mockImplementationOnce(async ({ request }) =>
        createBrokerReceipt({
          requestId: request.requestId,
          providerId: "acme",
          platform: request.platform,
          status: "sent",
          messageIds: ["preview-1"],
        }),
      )
      .mockRejectedValueOnce(new Error("final send failed"));
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "working" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            return {
              queuedFinal: false,
              counts: { tool: 1, block: 0, final: 1 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-preview-1",
      sendOutboundRequest,
    });

    await expect(
      handleChannelBrokerInboundHttpRequest({
        cfg: config,
        req: createRequest({ body, signature: sign(body, "broker-secret") }),
        res: createResponse(),
      }),
    ).rejects.toThrow("final send failed");

    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(200);
    expect(JSON.parse(redelivery.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
    expect(sendOutboundRequest).toHaveBeenCalledTimes(2);
  });

  it("deduplicates after agent dispatch even when durable final delivery fails", async () => {
    const config = brokerConfig();
    const account = resolveChannelBrokerAccount({ cfg: config, accountId: "acme" });
    const event = inboundEvent();
    const sendOutboundRequest = vi.fn().mockRejectedValue(new Error("durable send failed"));
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 1 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-final-1",
      sendOutboundRequest,
    });

    await expect(
      receiveBrokerInboundEvent({
        account,
        event,
        dedupeKey: "acme:bot-main:telegram:evt-1",
        ackPolicy: "after_agent_dispatch",
      }),
    ).rejects.toThrow("durable send failed");

    await expect(
      receiveBrokerInboundEvent({
        account,
        event,
        dedupeKey: "acme:bot-main:telegram:evt-1",
        ackPolicy: "after_agent_dispatch",
      }),
    ).resolves.toMatchObject({ status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("deduplicates after agent dispatch when the final-only durable hook fails", async () => {
    const config = brokerConfig();
    const account = resolveChannelBrokerAccount({ cfg: config, accountId: "acme" });
    const event = inboundEvent();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    vi.mocked(pluginRuntime.channel.inbound.run).mockImplementationOnce(async (params) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        throw new Error("missing broker input");
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      const preflight = (await params.adapter.preflight?.(input, eventClass)) ?? {};
      if ("kind" in preflight) {
        throw new Error(`unexpected broker preflight admission: ${preflight.kind}`);
      }
      const resolved = await params.adapter.resolveTurn(input, eventClass, preflight);
      if (!("delivery" in resolved)) {
        throw new Error("missing broker delivery adapter");
      }
      if (typeof resolved.delivery.durable !== "function") {
        throw new Error("missing broker durable delivery hook");
      }
      expect(resolved.delivery.durable({ text: "done" }, { kind: "final" })).toEqual(
        expect.objectContaining({
          to: "broker:telegram:-100123?conversationType=thread&threadId=77",
        }),
      );
      throw new Error("kernel durable send failed");
    });
    setChannelBrokerRuntime(pluginRuntime);

    await expect(
      receiveBrokerInboundEvent({
        account,
        event,
        dedupeKey: "acme:bot-main:telegram:evt-1",
        ackPolicy: "after_agent_dispatch",
      }),
    ).rejects.toThrow("kernel durable send failed");

    await expect(
      receiveBrokerInboundEvent({
        account,
        event,
        dedupeKey: "acme:bot-main:telegram:evt-1",
        ackPolicy: "after_agent_dispatch",
      }),
    ).resolves.toMatchObject({ status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("deduplicates broker webhook redeliveries before dispatching another turn", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    setChannelBrokerRuntime(pluginRuntime);

    const first = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: first,
    });
    const second = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: second,
    });

    expect(first.statusCode).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable response for redelivery while durable send is still pending", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    let rejectFirstTurn!: (error: Error) => void;
    vi.mocked(pluginRuntime.channel.inbound.run).mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectFirstTurn = reject;
        }),
    );
    setChannelBrokerRuntime(pluginRuntime);

    const first = handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: createResponse(),
    });
    await vi.waitFor(() => expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1));

    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(425);
    expect(JSON.parse(redelivery.body)).toMatchObject({
      ok: false,
      status: "pending",
      message: "delivery pending",
    });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);

    rejectFirstTurn(new Error("stop first turn"));
    await expect(first).rejects.toThrow("stop first turn");
  });

  it("keeps pending broker webhooks pending after runtime reset", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore },
    });
    let rejectFirstTurn!: (error: Error) => void;
    vi.mocked(pluginRuntime.channel.inbound.run).mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectFirstTurn = reject;
        }),
    );
    setChannelBrokerRuntime(pluginRuntime);

    const first = handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: createResponse(),
    });
    await vi.waitFor(() => expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1));

    resetChannelBrokerRuntimeForTest();
    setChannelBrokerRuntime(pluginRuntime);
    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(425);
    expect(JSON.parse(redelivery.body)).toMatchObject({
      ok: false,
      status: "pending",
      message: "delivery pending",
    });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);

    rejectFirstTurn(new Error("stop first turn"));
    await expect(first).rejects.toThrow("stop first turn");
  });

  it("keeps stale pending broker webhooks pending within the same runtime", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore },
    });
    let rejectFirstTurn!: (error: Error) => void;
    vi.mocked(pluginRuntime.channel.inbound.run).mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectFirstTurn = reject;
        }),
    );
    setChannelBrokerRuntime(pluginRuntime);

    const first = handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: createResponse(),
    });
    await vi.waitFor(() => expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1));

    openKeyedStore.ageRecords(11 * 60 * 1000);
    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(425);
    expect(JSON.parse(redelivery.body)).toMatchObject({
      ok: false,
      status: "pending",
      message: "delivery pending",
    });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);

    rejectFirstTurn(new Error("stop first turn"));
    await expect(first).rejects.toThrow("stop first turn");
  });

  it("reclaims stale pending broker webhooks after runtime reset", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const openKeyedStore = createOpenKeyedStoreMock();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore },
    });
    let rejectFirstTurn!: (error: Error) => void;
    vi.mocked(pluginRuntime.channel.inbound.run).mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectFirstTurn = reject;
        }),
    );
    setChannelBrokerRuntime(pluginRuntime);

    const first = handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: createResponse(),
    });
    await vi.waitFor(() => expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1));

    resetChannelBrokerRuntimeForTest();
    openKeyedStore.ageRecords(11 * 60 * 1000);
    setChannelBrokerRuntime(pluginRuntime);
    const retry = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: retry,
    });

    expect(retry.statusCode).toBe(202);
    expect(JSON.parse(retry.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(2);

    rejectFirstTurn(new Error("stale process stopped"));
    await expect(first).rejects.toThrow("stale process stopped");
  });

  it("deduplicates redelivery after visible durable send failures", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const visibleError = Object.assign(new Error("visible final failed"), {
      visibleReplySent: true,
    });
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    vi.mocked(pluginRuntime.channel.inbound.run).mockRejectedValueOnce(visibleError);
    setChannelBrokerRuntime(pluginRuntime);

    await expect(
      handleChannelBrokerInboundHttpRequest({
        cfg: config,
        req: createRequest({ body, signature: sign(body, "broker-secret") }),
        res: createResponse(),
      }),
    ).rejects.toThrow("visible final failed");

    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(redelivery.statusCode).toBe(200);
    expect(JSON.parse(redelivery.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("completes dedupe when failed preview counts are followed by visible final delivery", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const sendOutboundRequest = vi.fn(async ({ request }) =>
      createBrokerReceipt({
        requestId: request.requestId,
        providerId: "acme",
        platform: request.platform,
        status: "sent",
        messageIds: ["final-1"],
      }),
    );
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 1 },
              failedCounts: { tool: 1, block: 0, final: 0 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-final-1",
      sendOutboundRequest,
    });

    const first = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: first,
    });
    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(first.statusCode).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(redelivery.statusCode).toBe(200);
    expect(JSON.parse(redelivery.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("completes dedupe when failed preview counts are followed by durable final delivery", async () => {
    const config = brokerConfig();
    const account = resolveChannelBrokerAccount({ cfg: config, accountId: "acme" });
    const event = inboundEvent();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
    });
    vi.mocked(pluginRuntime.channel.inbound.run).mockImplementationOnce(async (params) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        throw new Error("missing broker input");
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      const preflight = (await params.adapter.preflight?.(input, eventClass)) ?? {};
      if ("kind" in preflight) {
        throw new Error(`unexpected broker preflight admission: ${preflight.kind}`);
      }
      const resolved = await params.adapter.resolveTurn(input, eventClass, preflight);
      if (!("delivery" in resolved)) {
        throw new Error("missing broker delivery adapter");
      }
      if (typeof resolved.delivery.durable !== "function") {
        throw new Error("missing broker durable delivery hook");
      }
      expect(resolved.delivery.durable({ text: "done" }, { kind: "final" })).toEqual(
        expect.objectContaining({
          to: "broker:telegram:-100123?conversationType=thread&threadId=77",
        }),
      );
      await resolved.delivery.onDelivered?.(
        { text: "done" },
        { kind: "final" },
        { visibleReplySent: true, messageIds: ["final-1"] },
      );
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: resolved.ctxPayload,
        routeSessionKey: resolved.routeSessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 1 },
          failedCounts: { tool: 1, block: 0, final: 0 },
        },
      };
    });
    setChannelBrokerRuntime(pluginRuntime);

    await expect(
      receiveBrokerInboundEvent({
        account,
        event,
        dedupeKey: "acme:bot-main:telegram:evt-1",
        ackPolicy: "after_durable_send",
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      receiveBrokerInboundEvent({
        account,
        event,
        dedupeKey: "acme:bot-main:telegram:evt-1",
        ackPolicy: "after_durable_send",
      }),
    ).resolves.toMatchObject({ status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("completes dedupe when dispatcher failed counts hide visible final delivery errors", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const visibleError = Object.assign(new Error("visible final failed"), {
      visibleReplySent: true,
    });
    const sendOutboundRequest = vi.fn().mockRejectedValue(visibleError);
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
            try {
              await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
            } catch (error) {
              dispatcherOptions.onError?.(error, { kind: "final" });
            }
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 0 },
              failedCounts: { tool: 0, block: 0, final: 1 },
            };
          }),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);
    setChannelBrokerRuntime({
      createRequestId: () => "broker-final-1",
      sendOutboundRequest,
    });

    const first = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: first,
    });
    const redelivery = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: redelivery,
    });

    expect(first.statusCode).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(redelivery.statusCode).toBe(200);
    expect(JSON.parse(redelivery.body)).toMatchObject({ ok: true, status: "duplicate" });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(1);
  });

  it("does not complete dedupe for dispatcher-side delivery failures", async () => {
    const body = inboundBody();
    const config = brokerConfig();
    const pluginRuntime = createPluginRuntimeMock({
      config: {
        current: () => config,
      },
      state: { openKeyedStore: createOpenKeyedStoreMock() },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => ({
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
            failedCounts: { tool: 0, block: 0, final: 1 },
          })),
        },
      },
    });
    setChannelBrokerRuntime(pluginRuntime);

    const first = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: first,
    });
    const retry = createResponse();
    await handleChannelBrokerInboundHttpRequest({
      cfg: config,
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res: retry,
    });

    expect(first.statusCode).toBe(425);
    expect(JSON.parse(first.body)).toMatchObject({
      ok: false,
      status: "rejected",
      message: "delivery_failed",
    });
    expect(retry.statusCode).toBe(425);
    expect(JSON.parse(retry.body)).toMatchObject({
      ok: false,
      status: "rejected",
      message: "delivery_failed",
    });
    expect(pluginRuntime.channel.inbound.run).toHaveBeenCalledTimes(2);
  });

  it("rejects stale inbound signatures before runtime dispatch", async () => {
    const body = inboundBody();
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();
    const staleTimestamp = TEST_SIGNATURE_TIMESTAMP - 10 * 60 * 1000;

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig(),
      req: createRequest({
        body,
        signature: sign(body, "broker-secret", staleTimestamp),
        timestamp: staleTimestamp,
      }),
      res,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      error: "invalid_signature_timestamp",
    });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("ignores self-originated inbound events before runtime dispatch", async () => {
    const body = inboundBody("bot-main", {
      sender: { id: "bot-main", isBot: true },
    });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig(),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      status: "ignored",
      reason: "self_sender",
    });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("ignores self-originated inbound events when the payload omits accountId", async () => {
    const body = inboundBody("acme", {
      accountId: undefined,
      sender: { id: "acme", isBot: true },
    });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", { allowFrom: ["acme"] }),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      status: "ignored",
      reason: "self_sender",
    });
    expect(receiveInboundEvent).not.toHaveBeenCalled();
  });

  it("still dispatches allowlisted bot senders that are not the broker account", async () => {
    const body = inboundBody("integration-bot", {
      sender: { id: "integration-bot", isBot: true },
    });
    const receiveInboundEvent = vi.fn(async () => ({ status: "accepted" as const }));
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", { allowFrom: ["integration-bot"] }),
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(receiveInboundEvent).toHaveBeenCalledOnce();
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

  it("accepts signed inbound events for a top-level default provider id", async () => {
    const body = inboundBody("user-1", { providerId: "acme" });
    const receiveInboundEvent = vi.fn(async () => ({ status: "accepted" as const }));
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: {
        channels: {
          "channel-broker": {
            defaultProviderId: "acme",
            baseUrl: "https://broker.example.test",
            signingSecret: "broker-secret",
            allowFrom: ["user-1"],
          },
        },
      },
      req: createRequest({ body, signature: sign(body, "broker-secret") }),
      res,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: "accepted" });
    expect(receiveInboundEvent).toHaveBeenCalledOnce();
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

  it("does not authorize broker senders by mutable handles", async () => {
    const body = inboundBody("blocked-user", { sender: { id: "blocked-user", handle: "lume" } });
    const receiveInboundEvent = vi.fn();
    setChannelBrokerRuntime({ receiveInboundEvent });
    const res = createResponse();

    await handleChannelBrokerInboundHttpRequest({
      cfg: brokerConfig("broker-secret", { allowFrom: ["lume"] }),
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
        allowFrom: ["tg:user-1"],
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

  it("applies built-in platform aliases before inbound platform allowlists and dedupe", async () => {
    const cases = [
      { alias: "teams", canonical: "microsoft-teams" },
      { alias: "googlechat", canonical: "google-chat" },
      { alias: "qq", canonical: "qqbot" },
      { alias: "weixin", canonical: "wechat" },
      { alias: "openclaw-weixin", canonical: "wechat" },
    ];
    const receiveInboundEvent = vi.fn(async () => ({ status: "accepted" as const }));
    setChannelBrokerRuntime({ receiveInboundEvent });

    for (const { alias, canonical } of cases) {
      const body = inboundBody("user-1", { eventId: `evt-${alias}`, platform: alias });
      const res = createResponse();

      await handleChannelBrokerInboundHttpRequest({
        cfg: brokerConfig("broker-secret", {
          platforms: [canonical],
          allowFrom: [`${alias}:user-1`],
        }),
        req: createRequest({ body, signature: sign(body, "broker-secret") }),
        res,
      });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        dedupeKey: `acme:bot-main:${canonical}:evt-${alias}`,
      });
      expect(receiveInboundEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ platform: canonical }),
          dedupeKey: `acme:bot-main:${canonical}:evt-${alias}`,
        }),
      );
    }
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
