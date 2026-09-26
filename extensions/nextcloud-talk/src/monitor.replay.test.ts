// Nextcloud Talk tests cover monitor.replay plugin behavior.
import { ServerResponse, type IncomingMessage } from "node:http";
import { createMockIncomingRequest, postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer, webhookRegistry } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";

function signWebhookBody(body: string) {
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret", // pragma: allowlist secret
  });
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

  const result = Promise.withResolvers<{ body: string; status: number }>();
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
  it.each([
    {
      path: "/nextcloud-query?tenant=a",
      rejected: [
        "/nextcloud-query",
        "/nextcloud-query?tenant=b",
        "/nextcloud-query?tenant=a&extra=1",
      ],
    },
    { path: "/nextcloud-plain", rejected: ["/nextcloud-plain?extra=1"] },
    {
      path: "/Nextcloud-Case/",
      rejected: ["/nextcloud-case/", "/Nextcloud-Case", "/Nextcloud-Case/?extra=1"],
    },
  ])("preserves the exact configured request path $path", async ({ path, rejected }) => {
    const onMessage = vi.fn();
    const harness = await startWebhookServer({ path, onMessage });
    const { body, headers } = createSignedCreateMessageRequest();
    const accepted = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(accepted.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
    const origin = new URL(harness.webhookUrl).origin;
    for (const requestPath of rejected) {
      readBody.mockClear();
      const response = await fetch(`${origin}${requestPath}`, { method: "POST", headers, body });
      expect(response.status).toBe(404);
      expect(readBody).not.toHaveBeenCalled();
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const wrongMethod = await fetch(harness.webhookUrl, { method });
      expect(wrongMethod.status).toBe(404);
      expect(await wrongMethod.text()).toBe("");
      expect(wrongMethod.headers.get("allow")).toBeNull();
    }
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("keeps absolute-form callback targets literal on legacy ports", async () => {
    const path = "https://callbacks.example/nextcloud?tenant=a";
    const legacyListener = { port: 8788, host: "127.0.0.1" };
    const onMessage = vi.fn();
    await startWebhookServer({ path, legacyListener, onMessage });
    const listener = webhookRegistry.httpRoutes[0]!.handler;
    const { body, headers } = createSignedCreateMessageRequest();
    for (const requestPath of [path, "/nextcloud?tenant=a"]) {
      const response = await invokeWebhookRequestListener({
        listener,
        path: requestPath,
        body,
        headers,
        remoteAddress: "198.51.100.20",
        legacyListener,
      });
      expect(response).toEqual({ status: requestPath === path ? 200 : 404, body: "" });
    }
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("selects query-distinguished accounts before matching their shared credentials", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = await startWebhookServer({ path: "/nextcloud-queries?tenant=a", onMessage: first });
    const b = await startWebhookServer({ path: "/nextcloud-queries?tenant=b", onMessage: second });
    const { body, headers } = createSignedCreateMessageRequest();
    expect((await fetch(a.webhookUrl, { method: "POST", headers, body })).status).toBe(200);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect((await fetch(b.webhookUrl, { method: "POST", headers, body })).status).toBe(200);
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
    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid backend" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("Nextcloud Talk Gateway webhook payload validation", () => {
  it.each([
    {},
    { "content-type": "text/plain; charset=iso-8859-1" },
    { "content-type": "application/json", "content-encoding": "gzip" },
  ])(
    "verifies the raw signed payload without interpreting media headers %j",
    async (mediaHeaders) => {
      const onMessage = vi.fn();
      const harness = await startWebhookServer({ path: "/nextcloud-raw-content", onMessage });
      const { body, headers } = createSignedCreateMessageRequest();
      const response = await fetch(harness.webhookUrl, {
        method: "POST",
        body: Buffer.from(body),
        headers: {
          "x-nextcloud-talk-random": headers["x-nextcloud-talk-random"],
          "x-nextcloud-talk-signature": headers["x-nextcloud-talk-signature"],
          "x-nextcloud-talk-backend": headers["x-nextcloud-talk-backend"],
          ...mediaHeaders,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      expect(onMessage).toHaveBeenCalledOnce();
    },
  );

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // Driven over a raw socket rather than fetch: the server answers while the sender is
    // still uploading and then closes, so both halves of the contract - the status is
    // delivered, and the rejected request does not stay open - have to be observed on the
    // wire. A mocked response records status(413) either way and proves neither half.
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

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      ...signWebhookBody(body),
    });

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
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

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      ...signWebhookBody(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
  });
});

describe("Nextcloud Talk Gateway webhook auth rate limiting", () => {
  it("rate limits repeated invalid signature attempts from the same source", async () => {
    const maxRequests = 1;
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit",
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const invalidHeaders = {
      ...headers,
      "x-nextcloud-talk-signature": "invalid-signature",
    };

    let firstResponse: Response | undefined;
    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= maxRequests; attempt += 1) {
      const response = await fetch(harness.webhookUrl, {
        method: "POST",
        headers: invalidHeaders,
        body,
      });
      if (attempt === 0) {
        firstResponse = response;
      }
      lastResponse = response;
    }

    expect(firstResponse?.status).toBe(401);
    expect(lastResponse?.status).toBe(429);
    expect(await lastResponse?.text()).toBe("Too Many Requests");
  });

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

    const firstAttack = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: attackerHeaders,
      body,
    });
    const blockedAttack = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: attackerHeaders,
      body,
    });
    const legitimateDelivery = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: { ...headers, "x-forwarded-for": "198.51.100.11" },
      body,
    });

    expect(firstAttack.status).toBe(401);
    expect(blockedAttack.status).toBe(429);
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
      const listener = webhookRegistry.httpRoutes.find((route) => route.path === path)?.handler;
      if (!listener) {
        throw new Error("expected Nextcloud Talk Gateway route");
      }
      const { body, headers } = createSignedCreateMessageRequest();
      const invalidHeaders = {
        ...headers,
        "x-nextcloud-talk-signature": "invalid-signature",
      };
      const invoke = (remoteAddress: string, requestHeaders: Record<string, string>) =>
        invokeWebhookRequestListener({
          listener,
          path,
          body,
          headers: requestHeaders,
          remoteAddress,
        });

      const firstAttack = await invoke("127.0.0.2", invalidHeaders);
      const blockedAttack = await invoke("127.0.0.2", invalidHeaders);
      const legitimateDelivery = await invoke("127.0.0.3", headers);

      expect(firstAttack.status).toBe(401);
      expect(blockedAttack.status).toBe(429);
      expect(legitimateDelivery.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("does not rate limit valid signed webhook bursts from the same source", async () => {
    const maxRequests = 1;
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit-valid",
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();

    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= maxRequests; attempt += 1) {
      lastResponse = await fetch(harness.webhookUrl, {
        method: "POST",
        headers,
        body,
      });
    }

    expect(lastResponse?.status).toBe(200);
  });
});

describe("Nextcloud Talk accounts sharing a Gateway route", () => {
  it("keeps a stopping account retryable without charging its sibling's auth budget", async () => {
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
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
    const pending = fetch(first.webhookUrl, { method: "POST", headers, body });
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
      const retry = await fetch(first.webhookUrl, { method: "POST", headers, body });
      expect(retry.status).toBe(503);
      expect(retry.headers.get("retry-after")).toBe("1");
      const signature = generateNextcloudTalkSignature({ body, secret: "second-secret" });
      const sibling = await fetch(first.webhookUrl, {
        method: "POST",
        body,
        headers: {
          ...headers,
          "x-nextcloud-talk-random": signature.random,
          "x-nextcloud-talk-signature": signature.signature,
        },
      });
      expect(sibling.status).toBe(200);
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
      const listener = webhookRegistry.httpRoutes.find((route) => route.path === path)?.handler;
      if (!listener) {
        throw new Error("expected shared Gateway webhook route");
      }
      const { body, headers } = createSignedCreateMessageRequest();
      const invoke = (legacyListener?: { port: number; host?: string }) =>
        invokeWebhookRequestListener({
          listener,
          path,
          body,
          headers,
          remoteAddress: "198.51.100.20",
          legacyListener,
        });
      expect((await invoke(firstEndpoint)).status).toBe(200);
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
      expect((await invoke(secondEndpoint)).status).toBe(200);
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
    const listener = webhookRegistry.httpRoutes.find((route) => route.path === path)?.handler;
    if (!listener) {
      throw new Error("expected shared Gateway webhook route");
    }
    const { body, headers } = createSignedCreateMessageRequest();
    const secondSignature = generateNextcloudTalkSignature({ body, secret: "second-secret" });
    const secondHeaders = {
      ...headers,
      "x-nextcloud-talk-random": secondSignature.random,
      "x-nextcloud-talk-signature": secondSignature.signature,
    };
    const invalidHeaders = { ...headers, "x-nextcloud-talk-signature": "invalid-signature" };
    const invoke = (
      requestHeaders: Record<string, string>,
      legacyListener?: { port: number; host?: string },
    ) =>
      invokeWebhookRequestListener({
        listener,
        path,
        body,
        headers: requestHeaders,
        remoteAddress: "198.51.100.20",
        legacyListener,
      });

    expect((await invoke(invalidHeaders, firstEndpoint)).status).toBe(401);
    expect((await invoke(headers, firstEndpoint)).status).toBe(429);
    const alternate = webhookRegistry.httpRoutes.find((route) => route.path === alternatePath)!;
    expect(
      (
        await invokeWebhookRequestListener({
          listener: alternate.handler,
          path: alternatePath,
          body,
          headers,
          remoteAddress: "198.51.100.20",
          legacyListener: firstEndpoint,
        })
      ).status,
    ).toBe(429);
    expect((await invoke(secondHeaders, secondEndpoint)).status).toBe(200);
    expect(second).toHaveBeenCalledOnce();
    expect((await invoke(headers)).status).toBe(200);
    expect(first).toHaveBeenCalledOnce();
    expect((await invoke(invalidHeaders)).status).toBe(401);
    expect((await invoke(secondHeaders)).status).toBe(429);
    expect((await invoke(secondHeaders, secondEndpoint)).status).toBe(200);
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
    const listener = webhookRegistry.httpRoutes.find((route) => route.path === path)?.handler;
    if (!listener) {
      throw new Error("expected shared Gateway webhook route");
    }
    const failure = new Error("legacy endpoint body read failed");
    readBody.mockImplementationOnce(() => {
      throw failure;
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const response = await invokeWebhookRequestListener({
      listener,
      path,
      body,
      headers,
      remoteAddress: "198.51.100.20",
      legacyListener: secondEndpoint,
    });
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
    const { body, headers } = createSignedCreateMessageRequest();
    const signature = generateNextcloudTalkSignature({ body, secret: "second-secret" });
    const signedHeaders = {
      ...headers,
      "x-nextcloud-talk-random": signature.random,
      "x-nextcloud-talk-signature": signature.signature,
    };
    const response = await fetch(firstHandle.webhookUrl, {
      method: "POST",
      headers: signedHeaders,
      body,
    });
    expect(response.status).toBe(200);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    await firstHandle.stop();
    const surviving = await fetch(secondHandle.webhookUrl, {
      method: "POST",
      headers: signedHeaders,
      body,
    });
    expect(surviving.status).toBe(200);
    expect(second).toHaveBeenCalledTimes(2);

    const duplicate = await startWebhookServer({ path, secret: "second-secret", onMessage: first });
    const ambiguous = await fetch(firstHandle.webhookUrl, {
      method: "POST",
      headers: signedHeaders,
      body,
    });
    expect(ambiguous.status).toBe(401);
    expect(second).toHaveBeenCalledTimes(2);
    await duplicate.stop();
  });

  it("serves an account registered by a duplicate module through the existing shared handler", async () => {
    const path = "/nextcloud-duplicate-module";
    const first = vi.fn();
    const second = vi.fn(async () => "accepted" as const);
    const harness = await startWebhookServer({ path, onMessage: first });
    vi.resetModules();
    const duplicate = await import("./monitor.js");
    const unregister = duplicate.registerNextcloudTalkWebhook({
      path,
      secret: "second-secret",
      onWebhook: second,
    });
    try {
      expect(webhookRegistry.httpRoutes).toHaveLength(1);
      const { body, headers } = createSignedCreateMessageRequest();
      const signature = generateNextcloudTalkSignature({ body, secret: "second-secret" });
      const accepted = await fetch(harness.webhookUrl, {
        method: "POST",
        body,
        headers: {
          ...headers,
          "x-nextcloud-talk-random": signature.random,
          "x-nextcloud-talk-signature": signature.signature,
        },
      });
      expect(accepted.status).toBe(200);
      expect(second).toHaveBeenCalledOnce();
      expect(first).not.toHaveBeenCalled();
      expect((await fetch(harness.webhookUrl, { method: "POST", headers, body })).status).toBe(200);
      expect(first).toHaveBeenCalledOnce();
    } finally {
      await unregister();
    }
  });
});
