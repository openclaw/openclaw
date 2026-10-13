import { ServerResponse, type IncomingMessage } from "node:http";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createMockIncomingRequest, postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNextcloudTalkWebhook } from "./monitor.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer, webhookRegistry } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";

afterEach(() => vi.useRealTimers());

function signWebhookBody(body: string, secret = "nextcloud-secret") {
  const { random, signature } = generateNextcloudTalkSignature({ body, secret });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": "https://nextcloud.example",
    },
  };
}

function postWebhook(
  url: string,
  request: { body: string; headers: Record<string, string> } = createSignedCreateMessageRequest(),
) {
  return fetch(url, { method: "POST", ...request });
}

function routeHandler(path: string) {
  const route = webhookRegistry.httpRoutes.find((entry) => entry.path === path);
  if (!route) {
    throw new Error(`expected Gateway route ${path}`);
  }
  return route.handler;
}

const { readBody, legacyListeners } = vi.hoisted(() => ({
  readBody: vi.fn(),
  legacyListeners: new WeakMap<IncomingMessage, { port: number; host?: string }>(),
}));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    WEBHOOK_RATE_LIMIT_DEFAULTS: { ...actual.WEBHOOK_RATE_LIMIT_DEFAULTS, maxRequests: 1 },
    getWebhookLegacyListener: (req: IncomingMessage) => legacyListeners.get(req),
    readRequestBodyWithLimit: (...args: Parameters<typeof actual.readRequestBodyWithLimit>) => {
      readBody();
      return actual.readRequestBodyWithLimit(...args);
    },
  };
});

async function invokeWebhookRequestListener(params: {
  listener: (typeof webhookRegistry.httpRoutes)[number]["handler"];
  path: string;
  body: string;
  headers: Record<string, string>;
  remoteAddress: string;
  legacyListener?: { port: number; host?: string };
}) {
  const req = Object.assign(createMockIncomingRequest([params.body]), {
    method: "POST",
    url: params.path,
    headers: params.headers,
  });
  Object.defineProperty(req.socket, "remoteAddress", { value: params.remoteAddress });
  if (params.legacyListener) {
    legacyListeners.set(req, params.legacyListener);
  }

  const result = createDeferred<{ body: string; status: number }>();
  const response = new ServerResponse(req);
  const res = Object.assign(response, {
    end(body?: string): ServerResponse {
      response.emit("finish");
      result.resolve({ body: body ?? "", status: response.statusCode });
      return response;
    },
  });
  await params.listener(req, res);
  return await result.promise;
}

function createInvoker(path: string, request = createSignedCreateMessageRequest()) {
  const listener = routeHandler(path);
  return (overrides: Partial<Parameters<typeof invokeWebhookRequestListener>[0]> = {}) =>
    invokeWebhookRequestListener({
      listener,
      path,
      ...request,
      remoteAddress: "198.51.100.20",
      ...overrides,
    });
}

describe("Nextcloud Talk Gateway webhook auth order", () => {
  it("rejects missing signature headers before reading request body", async () => {
    readBody.mockClear();
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-order",
      onMessage: vi.fn(),
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing signature headers" });
    expect(readBody).not.toHaveBeenCalled();
  });
});

describe("Nextcloud Talk exact webhook request paths", () => {
  it("selects query-distinguished accounts before matching their shared credentials", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = await startWebhookServer({ path: "/nextcloud-queries?tenant=a", onMessage: first });
    const b = await startWebhookServer({ path: "/nextcloud-queries?tenant=b", onMessage: second });
    const { body, headers } = createSignedCreateMessageRequest();
    expect((await postWebhook(a.webhookUrl, { headers, body })).status).toBe(200);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect((await postWebhook(b.webhookUrl, { headers, body })).status).toBe(200);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("Nextcloud Talk Gateway webhook backend allowlist", () => {
  it("rejects requests from unexpected backend origins", async () => {
    const onMessage = vi.fn(async () => {});
    const harness = await startWebhookServer({
      path: "/nextcloud-backend-check",
      isBackendAllowed: (backend) => backend === "https://nextcloud.expected",
      onMessage,
    });

    const { body, headers } = createSignedCreateMessageRequest({
      backend: "https://nextcloud.unexpected",
    });
    const response = await postWebhook(harness.webhookUrl, { headers, body });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid backend" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("Nextcloud Talk Gateway webhook payload validation", () => {
  it("does not acknowledge a failed durable append", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-append-failure",
      onWebhook: vi.fn(async () => {
        throw new Error("sqlite unavailable");
      }),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const response = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(response.status).toBe(500);
    expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
  });

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // A raw socket proves the rejection arrives before the incomplete upload closes.
    const body = JSON.stringify({ type: "Create", padding: "x".repeat(70 * 1024) });
    const onMessage = vi.fn();
    const harness = await startWebhookServer({
      path: "/nextcloud-oversized-body",
      onMessage,
    });

    const result = await postRawWebhook({
      url: harness.webhookUrl,
      ...signWebhookBody(body),
    });

    expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
    expect(result.body).toBe(JSON.stringify({ error: "Payload too large" }));
    expect(result.closedByServer).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("acknowledges signed non-Create Talk events instead of rejecting them", async () => {
    const payload = {
      type: "Join",
      actor: { type: "Application", id: "bots/bot-1", name: "Bot" },
      object: { type: "Collection", id: "room-1", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const onMessage = vi.fn();
    const harness = await startWebhookServer({
      path: "/nextcloud-lifecycle-event",
      onMessage,
    });

    const response = await postWebhook(harness.webhookUrl, signWebhookBody(body));

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
    expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
  });

  it("rejects malformed webhook payloads after signature verification", async () => {
    const payload = {
      type: "Create",
      actor: { type: "Person", id: "alice", name: "Alice" },
      object: {
        type: "Note",
        id: "msg-1",
        name: "hello",
        content: "hello",
        mediaType: "text/plain",
      },
      target: { type: "Collection", id: "", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const harness = await startWebhookServer({
      path: "/nextcloud-invalid-payload",
      onMessage: vi.fn(),
    });

    const response = await postWebhook(harness.webhookUrl, signWebhookBody(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
    expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
  });
});

describe("Nextcloud Talk Gateway webhook auth rate limiting", () => {
  it("isolates failed-auth limits by forwarded client behind a trusted proxy", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit-trusted-proxy",
      trustedProxies: ["127.0.0.1"],
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const attackerHeaders = {
      ...headers,
      "x-forwarded-for": "198.51.100.10",
      "x-nextcloud-talk-signature": "invalid-signature",
    };

    const firstAttack = await postWebhook(harness.webhookUrl, { headers: attackerHeaders, body });
    const blockedAttack = await postWebhook(harness.webhookUrl, { headers: attackerHeaders, body });
    const legitimateDelivery = await postWebhook(harness.webhookUrl, {
      headers: { ...headers, "x-forwarded-for": "198.51.100.11" },
      body,
    });

    expect(firstAttack.status).toBe(401);
    expect(blockedAttack.status).toBe(429);
    expect(await blockedAttack.text()).toBe("Too Many Requests");
    expect(legitimateDelivery.status).toBe(200);
  });

  it("keeps unattributed trusted proxies in separate socket buckets", async () => {
    const path = "/nextcloud-auth-rate-limit-proxy-fallback";
    const { stop } = await startWebhookServer({
      path,
      secret: "nextcloud-secret", // pragma: allowlist secret
      trustedProxies: ["127.0.0.0/8"],
      onWebhook: async () => "accepted",
    });
    try {
      const { body, headers } = createSignedCreateMessageRequest();
      const invalidHeaders = {
        ...headers,
        "x-nextcloud-talk-signature": "invalid-signature",
      };
      const invoke = createInvoker(path, { body, headers });

      const firstAttack = await invoke({ remoteAddress: "127.0.0.2", headers: invalidHeaders });
      const blockedAttack = await invoke({ remoteAddress: "127.0.0.2", headers: invalidHeaders });
      const legitimateDelivery = await invoke({ remoteAddress: "127.0.0.3" });

      expect(firstAttack.status).toBe(401);
      expect(blockedAttack.status).toBe(429);
      expect(legitimateDelivery.status).toBe(200);
    } finally {
      await stop();
    }
  });
});

describe("Nextcloud Talk accounts sharing a Gateway route", () => {
  it("keeps a stopping account retryable without charging its sibling's auth budget", async () => {
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    const path = "/nextcloud-stopping-account";
    const first = await startWebhookServer({
      path,
      onWebhook: async () => {
        admitted.resolve();
        await release.promise;
        return "accepted";
      },
    });
    const second = vi.fn();
    const siblingHandle = await startWebhookServer({
      path,
      secret: "second-secret",
      onMessage: second,
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const pending = postWebhook(first.webhookUrl, { headers, body });
    try {
      await admitted.promise;
      let siblingStopped = false;
      const stoppingSibling = siblingHandle.stop().then(() => {
        siblingStopped = true;
      });
      expect((await fetch(first.webhookUrl, { method: "GET" })).status).toBe(404);
      expect(siblingStopped).toBe(true);
      await stoppingSibling;
      await startWebhookServer({ path, secret: "second-secret", onMessage: second });
      const stopping = first.stop();
      const retry = await postWebhook(first.webhookUrl, { headers, body });
      expect(retry.status).toBe(503);
      expect(retry.headers.get("retry-after")).toBe("1");
      const sibling = await postWebhook(first.webhookUrl, signWebhookBody(body, "second-secret"));
      expect(sibling.status).toBe(200);
      expect(second).toHaveBeenCalledOnce();
      const successor = vi.fn();
      await startWebhookServer({ path, onMessage: successor });
      const transferred = await postWebhook(first.webhookUrl, { headers, body });
      expect(transferred.status).toBe(200);
      expect(successor).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      release.resolve();
      expect((await pending).status).toBe(200);
      await stopping;
    } finally {
      release.resolve();
      await pending;
      await first.stop();
    }
  });

  it.each([
    [
      { port: 8788, host: "127.0.0.1" },
      { port: 8789, host: "127.0.0.1" },
    ],
    [
      { port: 8788, host: "127.0.0.1" },
      { port: 8788, host: "127.0.0.2" },
    ],
  ])(
    "retains account selection for explicit legacy endpoints %j and %j",
    async (firstEndpoint, secondEndpoint) => {
      const path = "/nextcloud-legacy-accounts";
      const first = vi.fn();
      const second = vi.fn();
      const isBackendAllowed = (backend: string) => backend === "https://nextcloud.example";
      await startWebhookServer({
        path,
        legacyListener: firstEndpoint,
        isBackendAllowed,
        onMessage: first,
      });
      await startWebhookServer({
        path,
        legacyListener: secondEndpoint,
        isBackendAllowed,
        onMessage: second,
      });
      const invoke = createInvoker(path);
      expect((await invoke({ legacyListener: firstEndpoint })).status).toBe(200);
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
      expect((await invoke({ legacyListener: secondEndpoint })).status).toBe(200);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect((await invoke()).status).toBe(401);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    },
  );

  it("isolates legacy authentication failures while Gateway accounts share a quota", async () => {
    const path = "/nextcloud-legacy-auth-budgets";
    const firstEndpoint = { port: 8788, host: "127.0.0.1" };
    const secondEndpoint = { port: 8789, host: "127.0.0.1" };
    const first = vi.fn();
    const second = vi.fn();
    await startWebhookServer({ path, legacyListener: firstEndpoint, onMessage: first });
    await startWebhookServer({
      path,
      secret: "second-secret",
      legacyListener: secondEndpoint,
      onMessage: second,
    });
    const alternatePath = `${path}-alternate`;
    await startWebhookServer({
      path: alternatePath,
      legacyListener: firstEndpoint,
      onMessage: first,
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const secondHeaders = signWebhookBody(body, "second-secret").headers;
    const invalidHeaders = { ...headers, "x-nextcloud-talk-signature": "invalid-signature" };
    const invoke = createInvoker(path, { body, headers });

    expect((await invoke({ headers: invalidHeaders, legacyListener: firstEndpoint })).status).toBe(
      401,
    );
    expect((await invoke({ legacyListener: firstEndpoint })).status).toBe(429);
    const alternate = createInvoker(alternatePath, { body, headers });
    expect((await alternate({ legacyListener: firstEndpoint })).status).toBe(429);
    expect((await invoke({ headers: secondHeaders, legacyListener: secondEndpoint })).status).toBe(
      200,
    );
    expect(second).toHaveBeenCalledOnce();
    expect((await invoke()).status).toBe(200);
    expect(first).toHaveBeenCalledOnce();
    expect((await invoke({ headers: invalidHeaders })).status).toBe(401);
    expect((await invoke({ headers: secondHeaders })).status).toBe(429);
    expect((await invoke({ headers: secondHeaders, legacyListener: secondEndpoint })).status).toBe(
      200,
    );
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("reports body-reader failures through the selected legacy endpoint", async () => {
    const path = "/nextcloud-legacy-body-error";
    const firstEndpoint = { port: 8788, host: "127.0.0.1" };
    const secondEndpoint = { port: 8789, host: "127.0.0.1" };
    const firstError = vi.fn();
    const secondError = vi.fn();
    const onMessage = vi.fn();
    await startWebhookServer({
      path,
      legacyListener: firstEndpoint,
      onError: firstError,
      onMessage,
    });
    await startWebhookServer({
      path,
      legacyListener: secondEndpoint,
      onError: secondError,
      onMessage,
    });
    const failure = new Error("legacy endpoint body read failed");
    readBody.mockImplementationOnce(() => {
      throw failure;
    });
    const response = await createInvoker(path)({ legacyListener: secondEndpoint });
    expect(response.status).toBe(500);
    expect(secondError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(firstError).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("selects by backend and signature and rejects ambiguous credentials", async () => {
    const path = "/nextcloud-shared-route";
    const first = vi.fn();
    const second = vi.fn();
    const firstHandle = await startWebhookServer({ path, onMessage: first });
    const secondHandle = await startWebhookServer({
      path,
      secret: "second-secret",
      isBackendAllowed: (backend) => backend === "https://nextcloud.example",
      onMessage: second,
    });
    await startWebhookServer({
      path,
      secret: "second-secret",
      isBackendAllowed: (backend) => backend === "https://other.example",
      onMessage: first,
    });
    const { body } = createSignedCreateMessageRequest();
    const signedRequest = signWebhookBody(body, "second-secret");
    const response = await postWebhook(firstHandle.webhookUrl, signedRequest);
    expect(response.status).toBe(200);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    await firstHandle.stop();
    const surviving = await postWebhook(secondHandle.webhookUrl, signedRequest);
    expect(surviving.status).toBe(200);
    expect(second).toHaveBeenCalledTimes(2);

    const duplicate = await startWebhookServer({ path, secret: "second-secret", onMessage: first });
    const ambiguous = await postWebhook(firstHandle.webhookUrl, signedRequest);
    expect(ambiguous.status).toBe(401);
    expect(second).toHaveBeenCalledTimes(2);
    await duplicate.stop();
  });
});

describe("Nextcloud Talk shared webhook lifetime", () => {
  it("keeps the route and limiter until its last account stops, then releases both", async () => {
    vi.useFakeTimers();
    const registry = createTestRegistry();
    setActivePluginRegistry(registry);
    const baselineTimerCount = vi.getTimerCount();
    const target = { path: "/w", secret: "s", onWebhook: async () => "ignored" as const };
    const first = registerNextcloudTalkWebhook(target);
    const second = registerNextcloudTalkWebhook({ ...target, secret: "other" });
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    const legacyTarget = { ...target, legacyListener: { port: 8788, host: "127.0.0.1" } };
    const firstLegacy = registerNextcloudTalkWebhook(legacyTarget);
    const secondLegacy = registerNextcloudTalkWebhook({
      ...legacyTarget,
      path: "/other",
      secret: "other",
    });
    expect(registry.httpRoutes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 3);
    await firstLegacy();
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 3);
    await secondLegacy();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    await first();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    await second();
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
    await second();
    expect(registry.httpRoutes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });
});
