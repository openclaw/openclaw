import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../../../test/helpers/plugins/mock-http-response.js";
import { __testing, createCampfireWebhookHandler, registerCampfireWebhookRoute } from "./index.js";

function createJsonRequest(params: {
  method?: string;
  url?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
    on: (event: string, listener: (...args: unknown[]) => void) => IncomingMessage;
  };
  req.method = params.method ?? "POST";
  req.url = params.url ?? "/channels/campfire/webhook/default";
  req.headers = {
    "content-type": "application/json",
    ...params.headers,
  };
  req.destroyed = false;
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  const encodedBody = params.rawBody ?? JSON.stringify(params.body ?? {});
  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = originalOn(event, listener);
    if (!bodyScheduled && (event === "data" || event === "end")) {
      bodyScheduled = true;
      void Promise.resolve().then(() => {
        if (encodedBody.length > 0) {
          req.emit("data", Buffer.from(encodedBody, "utf-8"));
        }
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];

  return req;
}

const validPayload = {
  user: { id: 42, name: "Alice" },
  room: {
    id: 7,
    name: "General",
    path: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
  },
  message: {
    id: 99,
    body: { plain: "Hey help me" },
    path: "https://campfire.example.com/rooms/7/@99",
  },
};

function createOversizedValidPayload(charCount = 70 * 1024) {
  return {
    ...validPayload,
    message: {
      ...validPayload.message,
      body: {
        plain: "x".repeat(charCount),
      },
    },
  };
}

describe("createCampfireWebhookHandler", () => {
  afterEach(() => {
    __testing.resetCampfireWebhookPathReservations();
  });

  it("rejects non-POST requests", async () => {
    const handler = createCampfireWebhookHandler({ onInbound: vi.fn() });
    const req = createJsonRequest({ method: "GET" });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("POST");
  });

  it("rejects webhook requests with a mismatched secret", async () => {
    const handler = createCampfireWebhookHandler({
      webhookSecret: "expected",
      onInbound: vi.fn(),
    });
    const req = createJsonRequest({
      body: validPayload,
      headers: { "x-webhook-secret": "wrong" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("accepts requests when webhook secret is not configured", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({ onInbound });
    const req = createJsonRequest({
      url: "/channels/campfire/webhook/default?secret=anything",
      body: validPayload,
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(onInbound).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onInbound).toHaveBeenCalledWith(validPayload);
  });

  it("rejects malformed payloads", async () => {
    const handler = createCampfireWebhookHandler({ webhookSecret: "expected", onInbound: vi.fn() });
    const req = createJsonRequest({
      body: { user: { id: 42 } },
      headers: { "x-webhook-secret": "expected" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("returns 200 and dispatches inbound asynchronously", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({ webhookSecret: "expected", onInbound });
    const req = createJsonRequest({
      body: validPayload,
      headers: { "x-webhook-secret": "expected" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(onInbound).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onInbound).toHaveBeenCalledWith(validPayload);
  });

  it("accepts webhook secret from X-Webhook-Secret header", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({ webhookSecret: "header-secret", onInbound });
    const req = createJsonRequest({
      body: validPayload,
      headers: { "x-webhook-secret": "header-secret" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInbound).toHaveBeenCalledWith(validPayload);
  });

  it("rejects webhook request with wrong X-Webhook-Secret header", async () => {
    const handler = createCampfireWebhookHandler({
      webhookSecret: "correct",
      onInbound: vi.fn(),
    });
    const req = createJsonRequest({
      body: validPayload,
      headers: { "x-webhook-secret": "wrong" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("prefers X-Webhook-Secret header over query param", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({ webhookSecret: "from-header", onInbound });
    const req = createJsonRequest({
      url: "/channels/campfire/webhook/default?secret=wrong-param",
      body: validPayload,
      headers: { "x-webhook-secret": "from-header" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInbound).toHaveBeenCalledWith(validPayload);
  });

  it("falls back to query param secret when header is absent", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({ webhookSecret: "fallback-secret", onInbound });
    const req = createJsonRequest({
      url: "/channels/campfire/webhook/default?secret=fallback-secret",
      body: validPayload,
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInbound).toHaveBeenCalledWith(validPayload);
  });

  it("uses post-auth body limits after a matching webhook secret", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({
      webhookSecret: "expected",
      onInbound,
    });
    const req = createJsonRequest({
      body: createOversizedValidPayload(),
      headers: { "x-webhook-secret": "expected" },
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInbound).toHaveBeenCalledTimes(1);
  });

  it("keeps no-secret webhook requests on pre-auth body limits", async () => {
    const onInbound = vi.fn();
    const handler = createCampfireWebhookHandler({ onInbound });
    const req = createJsonRequest({
      body: createOversizedValidPayload(),
    });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(413);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("rejects when no secret is provided but one is configured", async () => {
    const handler = createCampfireWebhookHandler({
      webhookSecret: "required",
      onInbound: vi.fn(),
    });
    const req = createJsonRequest({ body: validPayload });
    const res = createMockServerResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("rejects duplicate webhook paths across different accounts", () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});

    const unregister = registerCampfireWebhookRoute({
      accountId: "default",
      path: "/channels/campfire/webhook/shared",
      webhookSecret: "secret",
      onInbound: vi.fn(),
      registerRoute,
    } as never);

    expect(() =>
      registerCampfireWebhookRoute({
        accountId: "support",
        path: "/channels/campfire/webhook/shared/",
        webhookSecret: "secret",
        onInbound: vi.fn(),
        registerRoute,
      } as never),
    ).toThrow(/already assigned to account "default"/);

    unregister();
  });

  it("allows reusing the same webhook path for one account", () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});

    const unregisterFirst = registerCampfireWebhookRoute({
      accountId: "default",
      path: "/channels/campfire/webhook/shared",
      webhookSecret: "secret",
      onInbound: vi.fn(),
      registerRoute,
    } as never);
    const unregisterSecond = registerCampfireWebhookRoute({
      accountId: "default",
      path: "/channels/campfire/webhook/shared/",
      webhookSecret: "secret",
      onInbound: vi.fn(),
      registerRoute,
    } as never);

    expect(registerRoute).toHaveBeenCalledTimes(2);

    unregisterSecond();
    unregisterFirst();
  });

  it("releases reserved paths when route registration fails", () => {
    const registerRoute = vi
      .fn<
        (
          params: Parameters<typeof registerCampfireWebhookRoute>[0] & {
            log?: (message: string) => void;
          },
        ) => () => void
      >()
      .mockImplementationOnce((params) => {
        params.log?.("plugin: route conflict at /channels/campfire/webhook/shared (exact)");
        return () => {};
      })
      .mockImplementationOnce(() => () => {});

    expect(() =>
      registerCampfireWebhookRoute({
        accountId: "default",
        path: "/channels/campfire/webhook/shared",
        webhookSecret: "secret",
        onInbound: vi.fn(),
        registerRoute: registerRoute as never,
      }),
    ).toThrow(/route conflict/i);

    const unregister = registerCampfireWebhookRoute({
      accountId: "support",
      path: "/channels/campfire/webhook/shared",
      webhookSecret: "secret",
      onInbound: vi.fn(),
      registerRoute: registerRoute as never,
    });

    expect(registerRoute).toHaveBeenCalledTimes(2);
    unregister();
  });
});
