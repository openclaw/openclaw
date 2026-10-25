import { ServerResponse, type IncomingMessage } from "node:http";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createMockIncomingRequest, postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNextcloudTalkWebhook } from "./monitor.js";
import { createSignedCreateMessageRequest, signWebhookBody } from "./monitor.test-fixtures.js";
import { startWebhookServer as startServer, webhookRegistry } from "./monitor.test-harness.js";

afterEach(() => vi.useRealTimers());
const path = "/nextcloud-test";
function startWebhookServer(
  options: Omit<Parameters<typeof startServer>[0], "path"> & { path?: string },
) {
  return startServer({ path, ...options });
}
async function startPair(
  firstOptions: Parameters<typeof startWebhookServer>[0],
  secondOptions: Parameters<typeof startWebhookServer>[0],
) {
  const first = vi.fn();
  const second = vi.fn();
  const firstHandle = await startWebhookServer({ onMessage: first, ...firstOptions });
  const secondHandle = await startWebhookServer({ onMessage: second, ...secondOptions });
  const expectDeliveries = (a: number, b: number) =>
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([a, b]);
  return { first, second, firstHandle, secondHandle, expectDeliveries };
}

function postWebhook(
  url: string,
  request: { body: string; headers: Record<string, string> } = createSignedCreateMessageRequest(),
) {
  return fetch(url, { method: "POST", ...request });
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

type InvokeOverrides = Partial<ReturnType<typeof createSignedCreateMessageRequest>> & {
  remoteAddress?: string;
  legacyListener?: { port: number; host?: string };
};
function createInvoker(routePath: string, request = createSignedCreateMessageRequest()) {
  const listener = expectDefined(
    webhookRegistry.httpRoutes.find((entry) => entry.path === routePath)?.handler,
    `Gateway route ${routePath}`,
  );
  return async ({
    body = request.body,
    headers = request.headers,
    remoteAddress = "198.51.100.20",
    legacyListener,
  }: InvokeOverrides = {}) => {
    const req = Object.assign(createMockIncomingRequest([body]), {
      method: "POST",
      url: routePath,
      headers,
    });
    Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress });
    if (legacyListener) {
      legacyListeners.set(req, legacyListener);
    }

    const result = createDeferred<{ body: string; status: number }>();
    const response = new ServerResponse(req);
    const res = Object.assign(response, {
      end(responseBody?: string): ServerResponse {
        response.emit("finish");
        result.resolve({ body: responseBody ?? "", status: response.statusCode });
        return response;
      },
    });
    await listener(req, res);
    return await result.promise;
  };
}

describe("Nextcloud Talk webhooks", () => {
  it.each<
    [
      string,
      number,
      string | undefined,
      (() => { body: string; headers: Record<string, string> })?,
      Parameters<typeof startWebhookServer>[0]?,
    ]
  >([
    [
      "missing signature headers",
      400,
      "Missing signature headers",
      () => ({ body: "{}", headers: { "content-type": "application/json" } }),
    ],
    [
      "unexpected backend",
      401,
      "Invalid backend",
      () => createSignedCreateMessageRequest({ backend: "https://nextcloud.unexpected" }),
      { isBackendAllowed: (backend) => backend === "https://nextcloud.expected" },
    ],
    [
      "failed durable append",
      500,
      undefined,
      undefined,
      {
        onWebhook: async () => {
          throw new Error("sqlite unavailable");
        },
      },
    ],
    [
      "ignored non-Create event",
      200,
      undefined,
      () => signWebhookBody(JSON.stringify({ type: "Join" })),
    ],
    [
      "malformed message identity",
      400,
      "Invalid payload format",
      () => {
        const payload: { target: { id: string } } = JSON.parse(
          createSignedCreateMessageRequest().body,
        );
        payload.target.id = "";
        return signWebhookBody(JSON.stringify(payload));
      },
    ],
  ])(
    "handles %s without claiming durable adoption",
    async (_label, status, error, request, options) => {
      readBody.mockClear();
      const onMessage = vi.fn();
      const harness = await startWebhookServer({ onMessage, ...options });
      const response = await postWebhook(harness.webhookUrl, request?.());
      expect(response.status).toBe(status);
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      expect(onMessage).not.toHaveBeenCalled();
      if (error) {
        await expect(response.json()).resolves.toEqual({ error });
      }
      if (error === "Missing signature headers") {
        expect(readBody).not.toHaveBeenCalled();
      }
    },
  );

  it("selects query-distinguished accounts before matching their shared credentials", async () => {
    const { firstHandle, secondHandle, expectDeliveries } = await startPair(
      { path: "/nextcloud-queries?tenant=a" },
      { path: "/nextcloud-queries?tenant=b" },
    );
    expect((await postWebhook(firstHandle.webhookUrl)).status).toBe(200);
    expectDeliveries(1, 0);
    expect((await postWebhook(secondHandle.webhookUrl)).status).toBe(200);
    expectDeliveries(1, 1);
  });

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // A raw socket proves the rejection arrives before the incomplete upload closes.
    const body = JSON.stringify({ type: "Create", padding: "x".repeat(70 * 1024) });
    const onMessage = vi.fn();
    const harness = await startWebhookServer({ onMessage });

    const result = await postRawWebhook({
      url: harness.webhookUrl,
      ...signWebhookBody(body),
    });

    expect(result).toMatchObject({
      statusLine: "HTTP/1.1 413 Payload Too Large",
      body: JSON.stringify({ error: "Payload too large" }),
      closedByServer: true,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it.each(["forwarded", "socket"] as const)(
    "isolates failed-auth limits by %s client behind trusted proxies",
    async (source) => {
      const harness = await startWebhookServer({
        trustedProxies: [source === "forwarded" ? "127.0.0.1" : "127.0.0.0/8"],
        ...(source === "socket"
          ? { onWebhook: async () => "accepted" as const }
          : { onMessage: vi.fn() }),
      });
      const { body, headers } = createSignedCreateMessageRequest();
      const direct = createInvoker(path, { body, headers });
      const invoke = async (ip: string, requestHeaders = headers) => {
        if (source === "socket") {
          return direct({ remoteAddress: ip, headers: requestHeaders });
        }
        const response = await postWebhook(harness.webhookUrl, {
          body,
          headers: { ...requestHeaders, "x-forwarded-for": ip },
        });
        return { status: response.status, body: await response.text() };
      };
      const [attacker, legitimate]: [string, string] =
        source === "forwarded" ? ["198.51.100.10", "198.51.100.11"] : ["127.0.0.2", "127.0.0.3"];
      const invalidHeaders = { ...headers, "x-nextcloud-talk-signature": "invalid-signature" };
      const first = await invoke(attacker, invalidHeaders);
      const blocked = await invoke(attacker, invalidHeaders);
      const delivered = await invoke(legitimate);
      expect([first.status, blocked.status, delivered.status]).toEqual([401, 429, 200]);
      expect(blocked.body).toBe("Too Many Requests");
    },
  );
  it("keeps a stopping account retryable without charging its sibling's auth budget", async () => {
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    const first = await startWebhookServer({
      onWebhook: async () => {
        admitted.resolve();
        await release.promise;
        return "accepted";
      },
    });
    const second = vi.fn();
    const siblingHandle = await startWebhookServer({ secret: "second-secret", onMessage: second });
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
      await startWebhookServer({ secret: "second-secret", onMessage: second });
      const stopping = first.stop();
      const retry = await postWebhook(first.webhookUrl, { headers, body });
      expect(retry.status).toBe(503);
      expect(retry.headers.get("retry-after")).toBe("1");
      const sibling = await postWebhook(first.webhookUrl, signWebhookBody(body, "second-secret"));
      expect(sibling.status).toBe(200);
      expect(second).toHaveBeenCalledOnce();
      const successor = vi.fn();
      await startWebhookServer({ onMessage: successor });
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

  it("retains account selection for explicit legacy endpoints with distinct hosts", async () => {
    const firstEndpoint = { port: 8788, host: "127.0.0.1" };
    const secondEndpoint = { port: 8788, host: "127.0.0.2" };
    const isBackendAllowed = (backend: string) => backend === "https://nextcloud.example";
    const { expectDeliveries } = await startPair(
      { legacyListener: firstEndpoint, isBackendAllowed },
      { legacyListener: secondEndpoint, isBackendAllowed },
    );
    const invoke = createInvoker(path);
    expect((await invoke({ legacyListener: firstEndpoint })).status).toBe(200);
    expectDeliveries(1, 0);
    expect((await invoke({ legacyListener: secondEndpoint })).status).toBe(200);
    expectDeliveries(1, 1);
    expect((await invoke()).status).toBe(401);
    expectDeliveries(1, 1);
  });

  it("isolates legacy authentication failures while Gateway accounts share a quota", async () => {
    const firstEndpoint = { port: 8788, host: "127.0.0.1" };
    const secondEndpoint = { port: 8789, host: "127.0.0.1" };
    const { first, second } = await startPair(
      { legacyListener: firstEndpoint },
      { secret: "second-secret", legacyListener: secondEndpoint },
    );
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
    const firstEndpoint = { port: 8788, host: "127.0.0.1" };
    const secondEndpoint = { port: 8789, host: "127.0.0.1" };
    const firstError = vi.fn();
    const secondError = vi.fn();
    const onMessage = vi.fn();
    await startPair(
      { legacyListener: firstEndpoint, onError: firstError, onMessage },
      { legacyListener: secondEndpoint, onError: secondError, onMessage },
    );
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
    const { first, second, firstHandle, secondHandle } = await startPair(
      {},
      {
        secret: "second-secret",
        isBackendAllowed: (backend) => backend === "https://nextcloud.example",
      },
    );
    await startWebhookServer({
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

    const duplicate = await startWebhookServer({ secret: "second-secret", onMessage: first });
    const ambiguous = await postWebhook(firstHandle.webhookUrl, signedRequest);
    expect(ambiguous.status).toBe(401);
    expect(second).toHaveBeenCalledTimes(2);
    await duplicate.stop();
  });
  it("keeps the route and limiter until its last account stops, then releases both", async () => {
    vi.useFakeTimers();
    const registry = webhookRegistry;
    const baselineTimerCount = vi.getTimerCount();
    const expectState = (routes: number, timers: number) =>
      expect([registry.httpRoutes.length, vi.getTimerCount() - baselineTimerCount]).toEqual([
        routes,
        timers,
      ]);
    const target = { path: "/w", secret: "s", onWebhook: async () => "ignored" as const };
    const first = registerNextcloudTalkWebhook(target);
    const second = registerNextcloudTalkWebhook({ ...target, secret: "other" });
    expectState(1, 0);
    const { body, headers } = createSignedCreateMessageRequest();
    const request = {
      body,
      headers: { ...headers, "x-nextcloud-talk-signature": "invalid-signature" },
    };
    const invoke = createInvoker(target.path, request);
    expect((await invoke()).status).toBe(401);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    const legacyTarget = { ...target, legacyListener: { port: 8788, host: "127.0.0.1" } };
    const firstLegacy = registerNextcloudTalkWebhook(legacyTarget);
    const secondLegacy = registerNextcloudTalkWebhook({
      ...legacyTarget,
      path: "/other",
      secret: "other",
    });
    expect(registry.httpRoutes).toHaveLength(2);
    expect((await createInvoker("/other", request)()).status).toBe(401);
    expect((await invoke({ legacyListener: legacyTarget.legacyListener })).status).toBe(401);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 3);
    await firstLegacy();
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 3);
    await secondLegacy();
    expectState(1, 1);
    await first();
    expectState(1, 1);
    await second();
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
    await second();
    expectState(0, 0);
  });
});
