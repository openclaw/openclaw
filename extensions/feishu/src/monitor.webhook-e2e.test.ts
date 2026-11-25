import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { resolveRequestClientIp } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import * as client from "./client.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";
import { createFeishuRuntimeMockModule } from "./monitor.test-mocks.js";
import {
  buildWebhookConfig,
  createFeishuWebhookTestAccount,
  createHeldWebhookDispatch,
  expectWebhookJson as expectJson,
  getGatewayPort,
  getGatewayServer,
  postSignedPayload,
  sendRawSignedFeishuRequest,
  signFeishuPayload,
  waitForWebhookRoute,
  waitForWebhookResponseClose,
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

const legacyListener = vi.hoisted(() => ({
  value: undefined as { port: number; host?: string } | undefined,
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: () => legacyListener.value,
}));

vi.mock("./probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./probe.js")>()),
  probeFeishu: vi.fn(async () => ({ ok: true, botOpenId: "bot_open_id" })),
  registerFeishuAiAgent: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { buildFeishuWebhookRateLimitKey } from "./monitor-rate-limit-key.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorFeishuProvider, type FeishuStatusSink } from "./monitor.js";
import { feishuWebhookRateLimiter } from "./monitor.state.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
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

type TransportOptions = Parameters<typeof monitorWebhook>[0];
const cleanups: Array<() => unknown> = [];

function startMonitor(options: TransportOptions, transport = monitorWebhook) {
  const abort = new AbortController();
  const monitor = transport({
    runtime: createRuntimeSpies(),
    ...options,
    abortSignal: abort.signal,
  });
  const stop = () => {
    abort.abort();
    return monitor;
  };
  cleanups.push(stop);
  return stop;
}

async function startWebhook(accountId: string, options: Partial<TransportOptions> = {}) {
  const account = options.account ?? createFeishuWebhookTestAccount(accountId);
  const port = await getGatewayPort();
  startMonitor({ account, accountId, eventDispatcher: {} as never, ...options });
  const url = `http://127.0.0.1:${port}${account.config.webhookPath}`;
  await waitForWebhookRoute(url);
  return url;
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
  return startMonitor({
    account: {
      ...account,
      encryptKey,
      config: { ...account.config, legacyWebhook: { port: legacyPort, host: "127.0.0.1" } },
    },
    accountId,
    ...transport,
  });
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

function expectAccepted(response: Response, value: string | null = "durable") {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-openclaw-delivery-accepted")).toBe(value);
}

const eventPayload = (event_type: string) => ({ schema: "2.0", header: { event_type }, event: {} });

describe("Feishu transport status publishing", () => {
  let now: number;
  beforeEach(() => {
    now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());
  type Patch = Parameters<FeishuStatusSink>[0];
  type Callbacks = NonNullable<Parameters<typeof client.createFeishuWSClient>[1]>;
  function expectPatch(actual: Patch | undefined, expected: Patch) {
    expect(actual).toMatchObject(expected);
    expect(actual?.lastTransportActivityAt).toBeUndefined();
  }
  async function startWsStatus(failure?: Error) {
    const patches: Patch[] = [];
    let callbacks: Callbacks = {};
    vi.spyOn(client, "createFeishuWSClient").mockImplementation(async (_account, received) => {
      if (failure) {
        throw failure;
      }
      callbacks = received ?? {};
      return { start: vi.fn(async () => undefined), close: vi.fn() } as never;
    });
    const account = createFeishuWebhookTestAccount("status");
    account.config.connectionMode = "websocket";
    startMonitor(
      {
        account,
        accountId: "status",
        eventDispatcher: {} as never,
        statusSink: (patch) => patches.push(patch),
      },
      monitorWebSocket,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return { patches, callbacks };
  }
  it("publishes connected state when the WS SDK reports ready or reconnected", async () => {
    const { patches, callbacks } = await startWsStatus();
    expect(patches).toEqual([]);
    for (const [index, callback] of [callbacks.onReady, callbacks.onReconnected].entries()) {
      callback?.();
      expectPatch(patches[index], {
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: now,
        lastEventAt: now,
        lastError: null,
      });
      if (index === 0) {
        expect(patches[0]?.terminalDisconnect).toBeUndefined();
        now += 1_000;
      }
    }
    now += 1_000;
    callbacks.onReconnecting?.();
    expectPatch(patches[2], { connected: false, lifecycle: "recovering", lastEventAt: now });
  });
  it.each([false, true])("publishes WS failure state (terminal=%s)", async (terminal) => {
    const { patches, callbacks } = await startWsStatus(terminal ? undefined : new Error("boom"));
    if (terminal) {
      callbacks.onError?.(new Error("WebSocket reconnect exhausted after 3 attempts"));
    }
    await vi.waitFor(() =>
      expectPatch(
        patches.find((patch) => patch.connected === false),
        {
          connected: false,
          lifecycle: terminal ? "blocked" : "recovering",
          lastEventAt: now,
          ...(terminal ? { terminalDisconnect: true } : {}),
        },
      ),
    );
  });
  it("publishes connected after Gateway route registration", async () => {
    const patches: Patch[] = [];
    await startWebhook("webhook-status", { statusSink: (patch) => patches.push(patch) });
    const connected = patches.find((patch) => patch.connected === true);
    expect(connected).toBeDefined();
    expectPatch(connected, {
      lifecycle: "ready",
      lastConnectedAt: now,
      lastEventAt: now,
    });
  });
});

afterEach(async () => {
  // Release held dispatches/sockets before their earlier-registered monitor drains.
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await Promise.resolve()
      .then(cleanup)
      .catch((error: unknown) => {
        failures.push(error);
      });
  }
  webhookBodyTimeoutMs.value = undefined;
  preAuthInFlightLimit.value = undefined;
  feishuWebhookRateLimiter.clear();
  legacyListener.value = undefined;
  await cleanupFeishuMonitorStateForTests();
  if (failures.length) {
    throw new AggregateError(failures, "Webhook fixture cleanup failed");
  }
});

afterAll(() => {
  vi.doUnmock("./monitor.state.js");
  vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.doUnmock("./probe.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

async function startRoute(account: ResolvedFeishuAccount) {
  const handler = vi.fn(async () => ({ accepted: true }));
  const statusSink = vi.fn();
  const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
  eventDispatcher.register({ "test.route": handler });
  const rawBody = JSON.stringify(eventPayload("test.route"));
  const url = await startWebhook(account.accountId, { account, eventDispatcher, statusSink });
  const port = Number(new URL(url).port);
  statusSink.mockClear();
  return async (target: string, status: number, method = "POST") => {
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
  };
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
    start(1, "second-key");
    const rawBody = JSON.stringify({ schema: "2.0", event: {} });
    const post = (encryptKey: string, body = rawBody) =>
      postSigned(`http://127.0.0.1:${port}${path}`, body, encryptKey);
    await expectJson(await post("first-key"), { account: "first" });
    await expectJson(await post("second-key"), { account: "second" });

    const invalidJson = await post("second-key", "{not-json");
    await expectText(invalidJson, 400, "Invalid JSON");
    expect(runtimes[1].log).toHaveBeenCalledWith(expect.stringContaining("webhook anomaly"));
    expect(runtimes[0].log.mock.calls.flat().join(" ")).not.toContain("webhook anomaly");
    dispatchers[1].mockRejectedValueOnce(new Error("second dispatch failed"));
    const failed = await post("second-key");
    expect(failed.headers.get("x-openclaw-delivery-accepted")).toBeNull();
    await expectText(failed, 500, "Internal Server Error");
    expect(runtimes[1].error).toHaveBeenCalledWith(
      expect.stringContaining("second dispatch failed"),
    );
    expect(runtimes[0].error).not.toHaveBeenCalled();

    const thirdMonitor = start(2, "second-key");
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
    await expectJson(await post("second-key"), { account: "second" });
  });

  it("admits signed requests only on the configured POST webhook route", async () => {
    const path = "/hook-e2e-route";
    const request = await startRoute(createFeishuWebhookTestAccount("route", path));
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
      const request = await startRoute(repaired);
      await request(path, 200);
    }
  });

  it("matches an explicitly configured webhook query exactly", async () => {
    const route = "/hook-e2e-query";
    const path = route + "?tenant=alpha&mode=exact";
    const request = await startRoute(createFeishuWebhookTestAccount("query", path));
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

  it("filters prototype-bearing keys without changing the Lark webhook envelope", async () => {
    const accountId = "prototype-guard";
    const encryptKey = "encrypt_key";
    const account = createFeishuWebhookTestAccount(accountId);
    const handler = vi.fn(async () => ({ accepted: true }));
    const dispatcher = new Lark.EventDispatcher({
      encryptKey,
      verificationToken: account.verificationToken,
    });
    dispatcher.register({ "test.prototype_guard": handler });

    const invoke = vi.spyOn(dispatcher, "invoke");
    const rawBody =
      '{"schema":"2.0","header":{"event_type":"test.prototype_guard"},"event":{"safe":"kept"},"headers":{"x-envelope-marker":"forged"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}';
    const headers = {
      ...signFeishuPayload({ encryptKey, rawBody }),
      "x-envelope-marker": "preserved",
    };

    const url = await startWebhook(accountId, { account, eventDispatcher: dispatcher });
    await expectJson(await postRaw(url, rawBody, headers), { accepted: true });
    const observedEnvelope: Record<string, unknown> | undefined = invoke.mock.calls[0]?.[0];
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

  it("accepts signed encrypted url_verification challenges end-to-end", async () => {
    await withRunningWebhookMonitor(
      {
        accountId: "encrypted-challenge",
        path: "/hook-encrypted-challenge",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const payload = {
          encrypt: encryptFeishuPayload("encrypt_key", {
            type: "url_verification",
            challenge: "encrypted-challenge-token",
          }),
        };
        const response = await postSignedPayload(url, payload);

        expectAccepted(response, null);
        await expectJson(response, { challenge: "encrypted-challenge-token" });
      },
    );
  });
});

function openWebhookRequest(
  url: string,
  body: string,
  { contentLength = Buffer.byteLength(body), hold = false, timeoutMs = 1_000 } = {},
) {
  const target = new URL(url);
  const socket = createConnection({ host: target.hostname, port: Number(target.port) });
  cleanups.push(() => {
    socket.destroy();
  });
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
      const statusSink = vi.fn();
      const url = await startWebhook(accountId, { statusSink });
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
        response = await openWebhookRequest(url, JSON.stringify({ payload: "x".repeat(70 * 1024) }))
          .response;
      }
      expect(response).toContain(`${status} ${reason}`);
      expect(response).toContain(body);
      expect(response).toMatch(/connection: close/i);
      await responseClosed;
      expect(statusSink).not.toHaveBeenCalled();
    },
  );

  it("rejects excess concurrent pre-auth webhook reads and recovers capacity", async () => {
    webhookBodyTimeoutMs.value = 5_000;
    const invokeWebhookEvent = vi.fn(async () => ({
      kind: "durable" as const,
      value: { accepted: true },
    }));
    const url = await startWebhook("pre-auth-inflight", { invokeWebhookEvent });
    const heldRequestsReceived = waitForWebhookRequests(64);
    const held = Array.from({ length: 64 }, () => openIncompleteWebhookRequest(url));
    await heldRequestsReceived;
    expect(held.every((request) => !request.isClosed())).toBe(true);

    const overflowStartedAt = Date.now();
    const overflow = openIncompleteWebhookRequest(url);
    const overflowResponse = await overflow.response;

    expect(overflowResponse).toContain("429 Too Many Requests");
    expect(overflowResponse).toMatch(/connection: close/i);
    expect(Date.now() - overflowStartedAt).toBeLessThan(400);
    expect(invokeWebhookEvent).not.toHaveBeenCalled();

    for (const request of held) {
      request.finish();
    }
    const heldResponses = await Promise.all(held.map((request) => request.response));
    expect(heldResponses.every((response) => response.includes("401 Unauthorized"))).toBe(true);

    const rawBody = JSON.stringify(eventPayload("test.pre_auth_inflight"));
    const recovered = await postSigned(url, rawBody);
    expectAccepted(recovered);
    expect(invokeWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps pre-auth capacity independent for distinct trusted legacy listeners", async () => {
    preAuthInFlightLimit.value = 1;
    webhookBodyTimeoutMs.value = 5_000;
    const { EventDispatcher } =
      await vi.importActual<typeof import("@larksuiteoapi/node-sdk")>("@larksuiteoapi/node-sdk");
    const path = "/hook-legacy-pre-auth";
    const port = await getGatewayPort();
    const url = `http://127.0.0.1:${port}${path}`;
    for (const legacyPort of [3000, 3001]) {
      startLegacyTarget(`legacy-${legacyPort}`, path, legacyPort, {
        eventDispatcher: new EventDispatcher({ encryptKey: "encrypt_key" }),
        invokeWebhookEvent: async () => ({ kind: "durable", value: { port: legacyPort } }),
      });
    }
    const heldReceived = waitForWebhookRequests();
    const heldClosed = waitForWebhookResponseClose();
    legacyListener.value = { port: 3000, host: "127.0.0.1" };
    const held = openIncompleteWebhookRequest(url);
    const post = () => postSigned(url, JSON.stringify({ schema: "2.0", event: {} }));
    cleanups.push(async () => {
      held.socket.destroy();
      await held.response;
      await heldClosed;
      legacyListener.value = undefined;
    });
    await heldReceived;
    expect(held.isClosed()).toBe(false);
    legacyListener.value = { port: 3001, host: "127.0.0.1" };
    await expectJson(await post(), { port: 3001 });
    legacyListener.value = { port: 3000, host: "127.0.0.1" };
    expect((await post()).status).toBe(429);
    expect(held.isClosed()).toBe(false);
  });

  it(
    "releases pre-auth capacity but waits for admission before acknowledging",
    { timeout: 15_000 },
    async () => {
      preAuthInFlightLimit.value = 1;
      const dispatch = createHeldWebhookDispatch({
        kind: "durable" as const,
        value: { accepted: true },
      });
      const invokeWebhookEvent = dispatch.handler;
      let acknowledged = false;
      const url = await startWebhook("pre-auth-dispatch", { invokeWebhookEvent });
      const rawBody = JSON.stringify(eventPayload("test.pre_auth_dispatch"));
      const signedRequest = postSigned(url, rawBody).then((response) => {
        acknowledged = true;
        return response;
      });
      cleanups.push(async () => {
        dispatch.release();
        await signedRequest.catch(() => undefined);
      });
      await dispatch.started;
      expect(invokeWebhookEvent).toHaveBeenCalledOnce();
      expect(acknowledged).toBe(false);
      await expectText(await postRaw(url, "{not-json"), 401, "Invalid signature");
      expect(invokeWebhookEvent).toHaveBeenCalledOnce();
      expect(acknowledged).toBe(false);
      dispatch.release();
      expectAccepted(await signedRequest);
    },
  );

  it("rate limits webhook burst traffic with 429", async () => {
    const url = await startWebhook("rate-limit");
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
      const url = await startWebhook("timestamp-skew");
      const payload = { type: "url_verification", challenge: "challenge-token" };
      const headers = signFeishuPayload({
        encryptKey: "encrypt_key",
        rawBody: JSON.stringify(payload),
        timestamp: (Math.floor(Date.now() / 1000) + offsetSeconds).toString(),
      });

      const response = await postRaw(url, JSON.stringify(payload), headers);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      await expectText(response, 401, "Invalid signature");
    },
  );
});
