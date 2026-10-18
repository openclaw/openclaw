import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRequestClientIp } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";
import { createFeishuRuntimeMockModule } from "./monitor.test-mocks.js";
import {
  buildWebhookConfig,
  createFeishuWebhookTestAccount,
  getGatewayPort,
  getGatewayServer,
  postSignedPayload,
  sendRawSignedFeishuRequest,
  signFeishuPayload,
  waitForWebhookRoute,
  withRunningWebhookMonitor,
} from "./monitor.webhook.test-helpers.js";

const webhookBodyTimeoutMs = vi.hoisted(() => ({ value: undefined as number | undefined }));
const preAuthInFlightLimit = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("openclaw/plugin-sdk/webhook-request-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/webhook-request-guards")>();
  return {
    ...actual,
    createWebhookInFlightLimiter: (
      options?: Parameters<typeof actual.createWebhookInFlightLimiter>[0],
    ) =>
      actual.createWebhookInFlightLimiter({
        ...options,
        ...(preAuthInFlightLimit.value === undefined
          ? {}
          : { maxInFlightPerKey: preAuthInFlightLimit.value }),
      }),
  };
});

vi.mock("./monitor.state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor.state.js")>();
  return {
    ...actual,
    get FEISHU_WEBHOOK_BODY_TIMEOUT_MS() {
      return webhookBodyTimeoutMs.value ?? actual.FEISHU_WEBHOOK_BODY_TIMEOUT_MS;
    },
  };
});

const probeFeishuMock = vi.hoisted(() => vi.fn());
const legacyListener = vi.hoisted(() => ({
  value: undefined as { port: number; host?: string } | undefined,
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: () => legacyListener.value,
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
  registerFeishuAiAgent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  };
});

vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { buildFeishuWebhookRateLimitKey } from "./monitor-rate-limit-key.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorFeishuProvider } from "./monitor.js";
import { feishuWebhookRateLimiter } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";

beforeAll(async () => {
  await import("./monitor.account.js");
});

function encryptFeishuPayload(encryptKey: string, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

function withSignedWebhook(
  accountId: string,
  run: Parameters<typeof withRunningWebhookMonitor>[2],
  options: Pick<Parameters<typeof withRunningWebhookMonitor>[0], "statusSink" | "runtime"> = {},
) {
  probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
  return withRunningWebhookMonitor(
    {
      accountId,
      path: `/hook-${accountId}`,
      verificationToken: "verify_token",
      encryptKey: "encrypt_key",
      ...options,
    },
    monitorFeishuProvider,
    run,
  );
}

async function withTransport(
  accountId: string,
  options: Partial<Parameters<typeof monitorWebhook>[0]>,
  run: (url: string) => Promise<void>,
  cleanup: () => void | Promise<void> = () => {},
) {
  const path = options.account?.config.webhookPath ?? `/hook-${accountId}`;
  const port = await getGatewayPort();
  const abort = new AbortController();
  const monitor = monitorWebhook({
    account: createFeishuWebhookTestAccount(accountId, path),
    accountId,
    eventDispatcher: {} as never,
    runtime: createRuntimeSpies(),
    ...options,
    abortSignal: abort.signal,
  });
  try {
    const url = `http://127.0.0.1:${port}${path}`;
    await waitForWebhookRoute(url);
    await run(url);
  } finally {
    await cleanup();
    abort.abort();
    await monitor;
  }
}

function startLegacyTarget(
  accountId: string,
  path: string,
  legacyPort: number,
  options: Pick<
    Parameters<typeof monitorWebhook>[0],
    "eventDispatcher" | "invokeWebhookEvent" | "runtime"
  > & { encryptKey?: string },
) {
  const { encryptKey = "encrypt_key", ...transport } = options;
  const account = createFeishuWebhookTestAccount(accountId, path);
  const abort = new AbortController();
  const monitor = monitorWebhook({
    account: {
      ...account,
      encryptKey,
      config: { ...account.config, legacyWebhook: { port: legacyPort, host: "127.0.0.1" } },
    },
    accountId,
    runtime: createRuntimeSpies(),
    ...transport,
    abortSignal: abort.signal,
  });
  return () => {
    abort.abort();
    return monitor;
  };
}

function postRaw(
  url: string,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  return fetch(url, { method: "POST", headers, body });
}

function postSigned(url: string, rawBody: string, encryptKey = "encrypt_key") {
  return postRaw(url, rawBody, signFeishuPayload({ encryptKey, rawBody }));
}

async function expectText(response: Response, status: number, body: string) {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(body);
}

async function expectJson(response: Response, value: unknown) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(value);
}

function expectAccepted(response: Response, value: string | null = "durable") {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-openclaw-delivery-accepted")).toBe(value);
}

function eventPayload(
  event_type: string,
  event: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  return { schema: "2.0", header: { event_type, ...header }, event };
}

afterEach(async () => {
  webhookBodyTimeoutMs.value = undefined;
  preAuthInFlightLimit.value = undefined;
  feishuWebhookRateLimiter.clear();
  legacyListener.value = undefined;
  await cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("./monitor.state.js");
  vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

async function withRoute(
  account: ResolvedFeishuAccount,
  run: (
    request: (target: string, status: number, method?: string) => Promise<void>,
  ) => Promise<void>,
) {
  const handler = vi.fn(async () => ({ accepted: true }));
  const statusSink = vi.fn();
  const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
  eventDispatcher.register({ "test.route": handler });
  const rawBody = JSON.stringify(eventPayload("test.route"));
  await withTransport(account.accountId, { account, eventDispatcher, statusSink }, async (url) => {
    const port = Number(new URL(url).port);
    statusSink.mockClear();
    await run(async (target, status, method = "POST") => {
      const dispatches = handler.mock.calls.length;
      const activity = statusSink.mock.calls.length;
      const response = await sendRawSignedFeishuRequest({
        port,
        target,
        method,
        rawBody,
        headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
      });
      const reason = status === 200 ? "OK" : status === 405 ? "Method Not Allowed" : "Not Found";
      expect(response.split("\r\n", 1)[0]).toBe(`HTTP/1.1 ${status} ${reason}`);
      expect(response.match(/\r\nallow:\s*([^\r\n]+)/i)?.[1] ?? null).toBe(
        status === 405 ? "POST" : null,
      );
      expect(handler).toHaveBeenCalledTimes(dispatches + Number(status === 200));
      expect(statusSink).toHaveBeenCalledTimes(activity + Number(status === 200));
    });
  });
}

describe("Feishu webhook signed-request e2e", () => {
  it("dispatches shared Gateway routes and honors trusted legacy-listener metadata", async () => {
    const path = "/hook-shared-accounts";
    const port = await getGatewayPort();
    const dispatchers = [
      vi.fn(async () => ({ account: "first" })),
      vi.fn(async () => ({ account: "second" })),
      vi.fn(async () => ({ account: "third" })),
    ] as const;
    const runtimes = [createRuntimeSpies(), createRuntimeSpies(), createRuntimeSpies()] as const;
    const start = (index: 0 | 1 | 2, encryptKey: string) => {
      const eventDispatcher = new Lark.EventDispatcher({ encryptKey });
      vi.spyOn(eventDispatcher, "invoke").mockImplementation(dispatchers[index]);
      return startLegacyTarget(`shared-${index}`, path, 3000 + index, {
        encryptKey,
        eventDispatcher,
        runtime: runtimes[index],
      });
    };
    const firstMonitor = start(0, "first-key");
    const monitors = [firstMonitor, start(1, "second-key")];
    const rawBody = JSON.stringify({ schema: "2.0", event: {} });
    const post = (encryptKey: string, body = rawBody) =>
      postSigned(`http://127.0.0.1:${port}${path}`, body, encryptKey);
    try {
      await expectJson(await post("first-key"), { account: "first" });
      await expectJson(await post("second-key"), { account: "second" });
      expect(dispatchers[0]).toHaveBeenCalledTimes(1);
      expect(dispatchers[1]).toHaveBeenCalledTimes(1);

      const invalidJson = await post("second-key", "{not-json");
      await expectText(invalidJson, 400, "Invalid JSON");
      expect(runtimes[1].log).toHaveBeenCalledWith(
        "feishu[shared-1]: webhook anomaly path=/hook-shared-accounts status=400 count=1",
      );
      expect(runtimes[0].log.mock.calls.flat().join(" ")).not.toContain("webhook anomaly");
      dispatchers[1].mockRejectedValueOnce(new Error("second dispatch failed"));
      const failed = await post("second-key");
      expect(failed.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      await expectText(failed, 500, "Internal Server Error");
      expect(runtimes[1].error).toHaveBeenCalledWith(
        "feishu[shared-1]: webhook handler error: Error: second dispatch failed",
      );
      expect(runtimes[0].error).not.toHaveBeenCalled();

      const thirdMonitor = start(2, "second-key");
      monitors.push(thirdMonitor);
      expect((await post("second-key")).status).toBe(401);
      expect(dispatchers[1]).toHaveBeenCalledTimes(2);
      expect(dispatchers[2]).not.toHaveBeenCalled();
      // This supplies the trusted Gateway boundary input, not a network or header claim.
      legacyListener.value = { port: 3001, host: "127.0.0.1" };
      expect((await post("second-key")).status).toBe(200);
      expect(dispatchers[1]).toHaveBeenCalledTimes(3);
      expect(dispatchers[2]).not.toHaveBeenCalled();
      legacyListener.value = { port: 3001 };
      expect((await post("second-key")).status).toBe(404);
      legacyListener.value = undefined;
      await thirdMonitor();
      await firstMonitor();
      const removedKey = await post("first-key");
      await expectText(removedKey, 401, "Invalid signature");
      expect((await post("second-key")).status).toBe(200);
      expect(dispatchers[1]).toHaveBeenCalledTimes(4);
    } finally {
      legacyListener.value = undefined;
      await Promise.all(monitors.map((stop) => stop()));
    }
  });

  it("returns 401 for unsigned invalid json before parsing", async () => {
    await withSignedWebhook("invalid-json", async (url) => {
      await expectText(await postRaw(url, "{not-json"), 401, "Invalid signature");
    });
  });

  it("admits signed requests only on the configured POST webhook route", async () => {
    const path = "/hook-e2e-route";
    await withRoute(createFeishuWebhookTestAccount("route", path), async (request) => {
      for (const target of [
        "/other",
        path + "/nested",
        path + "/",
        "//[",
        "//attacker" + path,
        "//localhost" + path,
        "/other/.." + path,
        "/other/%2e%2e" + path,
        "/\\attacker" + path,
        "/other\\.." + path,
        path + "%2Fextra",
        path + "#fragment",
        path + "?delivery=ok#fragment",
        path + "%ZZ",
      ]) {
        await request(target, 404);
      }
      await request(path, 405, "PUT");
      await request(path, 200);
      await request(path + "?delivery=validated", 200);
    });
  });

  it("repairs a mixed legacy webhook configuration before admitting its account routes", async () => {
    const config = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "secret_test",
          connectionMode: "webhook" as const,
          encryptKey: "encrypt_key",
          verificationToken: "verify_token",
          webhookPath: "https://example.com/old/?x=1#fragment",
          accounts: {
            inherited: {},
            relative: { webhookPath: "old?" },
            blank: { webhookPath: "   " },
            unchanged: { webhookPath: "/readyz/events" },
          },
        },
      },
    };
    const account = resolveFeishuRuntimeAccount(
      { cfg: config, accountId: "relative" },
      { requireEventSecrets: true },
    );
    expect(account.config.webhookPath).toBe("old?");
    await expect(
      monitorWebhook({
        account,
        accountId: account.accountId,
        eventDispatcher: new Lark.EventDispatcher({ encryptKey: "encrypt_key" }),
        runtime: createRuntimeSpies(),
      }),
    ).rejects.toThrow("openclaw doctor --fix");
    const migrated = normalizeCompatibilityConfig({ cfg: config });
    expect(migrated.changes.filter((change) => change.includes(".webhookPath"))).toHaveLength(3);
    expect(normalizeCompatibilityConfig({ cfg: migrated.config }).changes).toEqual([]);
    for (const [accountId, path] of [
      ["inherited", "/old/?x=1"],
      ["relative", "/old?"],
      ["blank", "/feishu/events"],
      ["unchanged", "/readyz/events"],
    ] as const) {
      const repaired = resolveFeishuRuntimeAccount(
        { cfg: migrated.config, accountId },
        { requireEventSecrets: true },
      );
      expect(repaired.config.webhookPath).toBe(path);
      await withRoute(repaired, async (request) => {
        await request(path, 200);
      });
    }
  });

  it("matches an explicitly configured webhook query exactly", async () => {
    const route = "/hook-e2e-query";
    const path = route + "?tenant=alpha&mode=exact";
    await withRoute(createFeishuWebhookTestAccount("query", path), async (request) => {
      for (const target of [
        route,
        route + "?tenant=other&mode=exact",
        route + "?mode=exact&tenant=alpha",
        path + "&extra=value",
      ]) {
        await request(target, 404);
      }
      await request(path, 405, "PUT");
      await request(path, 200);
    });
  });

  it("acks durable envelopes only after ingress admission resolves", async () => {
    const admission = createDeferred<void>();
    const invoke = vi.fn(async () => await admission.promise);
    const invokeWebhookEvent = async () => {
      await invoke();
      return { kind: "durable" as const, value: undefined };
    };
    await withTransport(
      "durable-ack-ordering",
      { eventDispatcher: { invoke } as never, invokeWebhookEvent },
      async (url) => {
        const payload = eventPayload(
          "im.message.receive_v1",
          { message: { chat_id: "oc_durable_ack_ordering" } },
          { event_id: "evt-durable-ack-ordering-1" },
        );
        let acceptedResponseReceived = false;
        const acceptedRequest = postSignedPayload(url, payload).then((response) => {
          acceptedResponseReceived = true;
          return response;
        });
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
        expect(acceptedResponseReceived).toBe(false);
        admission.resolve();
        expectAccepted(await acceptedRequest);
      },
      () => admission.resolve(),
    );
  });

  it("filters prototype-bearing keys without changing the Lark webhook envelope", async () => {
    const accountId = "prototype-guard";
    const encryptKey = "encrypt_key";
    const account = createFeishuWebhookTestAccount(accountId, `/hook-${accountId}`);
    const handler = vi.fn(async () => ({ accepted: true }));
    const dispatcher = new Lark.EventDispatcher({
      encryptKey,
      verificationToken: account.verificationToken,
    });
    dispatcher.register({ "test.prototype_guard": handler });

    let observedEnvelope: Record<string, unknown> | undefined;
    const invoke = dispatcher.invoke.bind(dispatcher);
    const eventDispatcher = {
      invoke: async (data: Record<string, unknown>, params?: { needCheck?: boolean }) => {
        observedEnvelope = data;
        return await invoke(data, params);
      },
    } as Lark.EventDispatcher;
    const rawBody =
      '{"schema":"2.0","header":{"event_type":"test.prototype_guard"},"event":{"safe":"kept"},"headers":{"x-envelope-marker":"forged"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}';
    const headers = {
      ...signFeishuPayload({ encryptKey, rawBody }),
      "x-envelope-marker": "preserved",
    };

    await withTransport(accountId, { account, eventDispatcher }, async (url) => {
      await expectJson(await postRaw(url, rawBody, headers), { accepted: true });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(observedEnvelope).toBeDefined();
      if (!observedEnvelope) {
        throw new Error("expected Lark webhook envelope");
      }
      const envelopePrototype = Object.getPrototypeOf(observedEnvelope) as Record<string, unknown>;
      expect(Object.hasOwn(observedEnvelope, "headers")).toBe(false);
      expect(Object.hasOwn(envelopePrototype, "headers")).toBe(true);
      expect(observedEnvelope.headers).toMatchObject({ "x-envelope-marker": "preserved" });
      expect(observedEnvelope.event).toEqual({ safe: "kept" });
      expect(observedEnvelope.polluted).toBeUndefined();
      for (const key of ["__proto__", "constructor", "prototype"]) {
        expect(Object.hasOwn(observedEnvelope, key)).toBe(false);
      }
    });
  });

  it("accepts signed encrypted url_verification challenges end-to-end", async () => {
    await withSignedWebhook("encrypted-challenge", async (url) => {
      const payload = {
        encrypt: encryptFeishuPayload("encrypt_key", {
          type: "url_verification",
          challenge: "encrypted-challenge-token",
        }),
      };
      const response = await postSignedPayload(url, payload);

      expectAccepted(response, null);
      await expectJson(response, { challenge: "encrypted-challenge-token" });
    });
  });
});

function openWebhookRequest(
  url: string,
  body: string,
  { contentLength = Buffer.byteLength(body), hold = false, timeoutMs = 1_000 } = {},
) {
  const target = new URL(url);
  const socket = createConnection({ host: target.hostname, port: Number(target.port) });
  let received = "";
  let settled = false;
  const response = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error("webhook request did not close within " + timeoutMs + "ms"));
      socket.destroy();
    }, timeoutMs);
    function finish(error?: Error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(received);
      }
    }
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("close", () => finish());
    socket.on("error", (error) => {
      finish(received.includes("Payload too large") ? undefined : error);
    });
    socket.once("connect", () => {
      socket.write(
        `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.hostname}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${contentLength}\r\n` +
          `Connection: close\r\n\r\n${hold ? body.slice(0, -1) : body}`,
      );
    });
  });
  return { socket, response, finish: () => socket.write(body.slice(-1)), isClosed: () => settled };
}

function openIncompleteWebhookRequest(url: string) {
  return openWebhookRequest(url, '{"type":"url_verification"}', { hold: true, timeoutMs: 10_000 });
}

function resolveTestClientIp(remoteAddress: string | undefined): string | undefined {
  return resolveRequestClientIp({
    headers: {},
    socket: { remoteAddress },
  } as IncomingMessage);
}

function rateLimitKey(clientIp?: string) {
  return buildFeishuWebhookRateLimitKey({
    accountId: "rate-limit-key",
    path: "/hook-rate-limit-key",
    clientIp,
  });
}

function waitForWebhookResponseClose(): Promise<void> {
  const server = getGatewayServer();
  return new Promise<void>((resolve) => {
    server.once("request", (_req, res) => res.once("close", resolve));
  });
}

function waitForWebhookRequests(count = 1) {
  const server = getGatewayServer();
  let remaining = count;
  return new Promise<void>((resolve) => {
    const onRequest = () => {
      if (--remaining === 0) {
        server.off("request", onRequest);
        resolve();
      }
    };
    server.on("request", onRequest);
  });
}

describe("Feishu webhook security hardening", () => {
  beforeEach(() => {
    webhookBodyTimeoutMs.value = 50;
  });
  it.each([
    { missing: "verificationToken", verificationToken: undefined },
    { missing: "encryptKey", verificationToken: "verify_token" },
  ])("rejects webhook mode without $missing", async ({ missing, verificationToken }) => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    const config = buildWebhookConfig({
      accountId: `missing-${missing}`,
      path: `/hook-missing-${missing}`,
      verificationToken,
    });
    await expect(monitorFeishuProvider({ config })).rejects.toThrow(`requires ${missing}`);
  });

  it.each([
    ["payload-too-large", 413, "Payload Too Large", "Payload too large"],
    ["slow-body-timeout", 408, "Request Timeout", "Request body timeout"],
  ])(
    "rejects %s unsigned bodies before authentication",
    async (accountId, status, reason, body) => {
      const runtime = createRuntimeSpies();
      const statusSink = vi.fn();
      await withSignedWebhook(
        accountId,
        async (url) => {
          statusSink.mockClear();
          const responseClosed = waitForWebhookResponseClose();
          let response: string;
          if (status === 408) {
            const started = Date.now();
            response = await openWebhookRequest(url, '{"type":"url_verification"', {
              contentLength: 65536,
              timeoutMs: 1_000,
            }).response;
            expect(Date.now() - started).toBeLessThan(500);
          } else {
            response = await openWebhookRequest(
              url,
              JSON.stringify({ payload: "x".repeat(70 * 1024) }),
            ).response;
          }
          expect(response).toContain(`${status} ${reason}`);
          expect(response).toContain(body);
          expect(response).toMatch(/connection: close/i);
          await responseClosed;
          expect(
            runtime.log.mock.calls.filter(([message]) => message.includes("webhook anomaly")),
          ).toEqual([
            [
              `feishu[${accountId}]: webhook anomaly path=/hook-${accountId} status=${status} count=1`,
            ],
          ]);
          expect(statusSink).not.toHaveBeenCalled();
        },
        { runtime, statusSink },
      );
    },
  );

  it("rejects excess concurrent pre-auth webhook reads and recovers capacity", async () => {
    webhookBodyTimeoutMs.value = 5_000;
    const invokeWebhookEvent = vi.fn(async () => ({
      kind: "durable" as const,
      value: { accepted: true },
    }));
    const openRequests: Array<ReturnType<typeof openIncompleteWebhookRequest>> = [];
    await withTransport(
      "pre-auth-inflight",
      { invokeWebhookEvent },
      async (url) => {
        const heldRequestsReceived = waitForWebhookRequests(64);
        const held = Array.from({ length: 64 }, () => openIncompleteWebhookRequest(url));
        openRequests.push(...held);
        await heldRequestsReceived;
        expect(held.every((request) => !request.isClosed())).toBe(true);

        const overflowStartedAt = Date.now();
        const overflow = openIncompleteWebhookRequest(url);
        openRequests.push(overflow);
        const overflowResponse = await overflow.response;

        expect(overflowResponse).toContain("429 Too Many Requests");
        expect(overflowResponse).toMatch(/connection: close/i);
        expect(Date.now() - overflowStartedAt).toBeLessThan(400);
        expect(invokeWebhookEvent).not.toHaveBeenCalled();

        for (const request of held) {
          request.finish();
        }
        const heldResponses = await Promise.all(held.map((request) => request.response));
        expect(heldResponses).toHaveLength(64);
        expect(heldResponses.every((response) => response.includes("401 Unauthorized"))).toBe(true);

        const rawBody = JSON.stringify(eventPayload("test.pre_auth_inflight"));
        const recovered = await postSigned(url, rawBody);
        expectAccepted(recovered);
        expect(invokeWebhookEvent).toHaveBeenCalledTimes(1);
      },
      () => {
        for (const request of openRequests) {
          request.socket.destroy();
        }
        webhookBodyTimeoutMs.value = 50;
      },
    );
  });

  it("keeps pre-auth capacity independent for distinct trusted legacy listeners", async () => {
    preAuthInFlightLimit.value = 1;
    webhookBodyTimeoutMs.value = 5_000;
    const { EventDispatcher } =
      await vi.importActual<typeof import("@larksuiteoapi/node-sdk")>("@larksuiteoapi/node-sdk");
    const path = "/hook-legacy-pre-auth";
    const port = await getGatewayPort();
    const url = `http://127.0.0.1:${port}${path}`;
    const monitors = [3000, 3001].map((legacyPort) =>
      startLegacyTarget(`legacy-${legacyPort}`, path, legacyPort, {
        eventDispatcher: new EventDispatcher({ encryptKey: "encrypt_key" }),
        invokeWebhookEvent: async () => ({ kind: "durable", value: { port: legacyPort } }),
      }),
    );
    const heldReceived = waitForWebhookRequests();
    const heldClosed = waitForWebhookResponseClose();
    legacyListener.value = { port: 3000, host: "127.0.0.1" };
    const held = openIncompleteWebhookRequest(url);
    const post = () => postSigned(url, JSON.stringify({ schema: "2.0", event: {} }));
    try {
      await heldReceived;
      expect(held.isClosed()).toBe(false);
      legacyListener.value = { port: 3001, host: "127.0.0.1" };
      await expectJson(await post(), { port: 3001 });
      legacyListener.value = { port: 3000, host: "127.0.0.1" };
      expect((await post()).status).toBe(429);
      expect(held.isClosed()).toBe(false);
    } finally {
      held.socket.destroy();
      await held.response;
      await heldClosed;
      legacyListener.value = undefined;
      await Promise.all(monitors.map((stop) => stop()));
    }
  });

  it("releases pre-auth capacity before signed event dispatch", { timeout: 15_000 }, async () => {
    preAuthInFlightLimit.value = 1;
    const dispatchGate = createDeferred<void>();
    const invokeWebhookEvent = vi.fn(async () => {
      await dispatchGate.promise;
      return { kind: "durable" as const, value: { accepted: true } };
    });
    let signedRequest: Promise<Response> | undefined;
    await withTransport(
      "pre-auth-dispatch",
      { invokeWebhookEvent },
      async (url) => {
        const rawBody = JSON.stringify(eventPayload("test.pre_auth_dispatch"));
        signedRequest = postSigned(url, rawBody);
        await vi.waitFor(() => expect(invokeWebhookEvent).toHaveBeenCalledOnce(), {
          timeout: 5_000,
          interval: 10,
        });

        const admittedInvalidSignature = await postRaw(url, "{}");
        expect(admittedInvalidSignature.status).toBe(401);
        expect(invokeWebhookEvent).toHaveBeenCalledOnce();

        dispatchGate.resolve();
        expect((await signedRequest).status).toBe(200);
      },
      async () => {
        dispatchGate.resolve();
        if (signedRequest) {
          await signedRequest.catch(() => undefined);
        }
      },
    );
  });

  it("rate limits webhook burst traffic with 429", async () => {
    await withSignedWebhook("rate-limit", async (url) => {
      let saw429 = false;
      for (let i = 0; i < 130; i += 1) {
        const response = await postRaw(url, "{}", { "content-type": "text/plain" });
        if (i === 0) {
          expect(response.status).toBe(415);
          expect(await response.text()).toBe("Unsupported Media Type");
        }
        if (response.status === 429) {
          saw429 = true;
          expect(await response.text()).toBe("Too Many Requests");
          break;
        }
      }

      expect(saw429).toBe(true);
    });
  });

  it("uses one webhook rate-limit key for loopback address-family variants", () => {
    for (const address of ["127.0.0.1", "127.0.0.42", "::ffff:127.0.0.1", "::1"]) {
      expect(rateLimitKey(resolveTestClientIp(address))).toBe(
        "rate-limit-key:/hook-rate-limit-key:loopback",
      );
    }
  });

  it("keeps non-loopback and unknown webhook rate-limit key suffixes distinct", () => {
    expect(rateLimitKey("10.0.0.1")).toBe("rate-limit-key:/hook-rate-limit-key:10.0.0.1");
    expect(rateLimitKey()).toBe("rate-limit-key:/hook-rate-limit-key:unknown");
  });

  it.each([-7_200, 7_200])(
    "rejects correctly signed callbacks with %i seconds of timestamp skew",
    async (offsetSeconds) => {
      await withSignedWebhook("timestamp-skew", async (url) => {
        const payload = { type: "url_verification", challenge: "challenge-token" };
        const headers = signFeishuPayload({
          encryptKey: "encrypt_key",
          rawBody: JSON.stringify(payload),
          timestamp: (Math.floor(Date.now() / 1000) + offsetSeconds).toString(),
        });

        const response = await postRaw(url, JSON.stringify(payload), headers);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        await expectText(response, 401, "Invalid signature");
      });
    },
  );
});
