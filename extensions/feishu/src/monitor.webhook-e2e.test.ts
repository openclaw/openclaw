// Feishu tests cover monitor.webhook e2e plugin behavior.
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
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
  const port = await getGatewayPort();
  const handler = vi.fn(async () => ({ accepted: true }));
  const statusSink = vi.fn();
  const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
  eventDispatcher.register({ "test.route": handler });
  const abort = new AbortController();
  const monitor = monitorWebhook({
    account,
    accountId: account.accountId,
    eventDispatcher,
    statusSink,
    abortSignal: abort.signal,
    runtime: createRuntimeSpies(),
  });
  const rawBody = JSON.stringify({
    schema: "2.0",
    header: { event_type: "test.route" },
    event: {},
  });
  try {
    await waitForWebhookRoute("http://127.0.0.1:" + port + account.config.webhookPath);
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
      expect(response.split("\r\n", 1)[0]).toBe(
        "HTTP/1.1 " +
          status +
          " " +
          (status === 200 ? "OK" : status === 405 ? "Method Not Allowed" : "Not Found"),
      );
      expect(response.match(/\r\nallow:\s*([^\r\n]+)/i)?.[1] ?? null).toBe(
        status === 405 ? "POST" : null,
      );
      expect(handler).toHaveBeenCalledTimes(dispatches + Number(status === 200));
      expect(statusSink).toHaveBeenCalledTimes(activity + Number(status === 200));
    });
  } finally {
    abort.abort();
    await monitor;
  }
}

describe("Feishu webhook signed-request e2e", () => {
  it("dispatches shared Gateway routes and honors trusted legacy-listener metadata", async () => {
    const path = "/hook-shared-accounts";
    const port = await getGatewayPort();
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ] as const;
    const dispatchers = [
      vi.fn(async () => ({ account: "first" })),
      vi.fn(async () => ({ account: "second" })),
      vi.fn(async () => ({ account: "third" })),
    ] as const;
    const runtimes = [createRuntimeSpies(), createRuntimeSpies(), createRuntimeSpies()] as const;
    const start = (index: 0 | 1 | 2, encryptKey: string) => {
      const account = createFeishuWebhookTestAccount(`shared-${index}`, path);
      const eventDispatcher = new Lark.EventDispatcher({ encryptKey });
      vi.spyOn(eventDispatcher, "invoke").mockImplementation(dispatchers[index]);
      return monitorWebhook({
        account: {
          ...account,
          encryptKey,
          config: { ...account.config, legacyWebhook: { port: 3000 + index, host: "127.0.0.1" } },
        },
        accountId: `shared-${index}`,
        abortSignal: controllers[index].signal,
        eventDispatcher,
        runtime: runtimes[index],
      });
    };
    const monitors = [start(0, "first-key"), start(1, "second-key")];
    const rawBody = JSON.stringify({ schema: "2.0", event: {} });
    const post = (encryptKey: string, body = rawBody) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: signFeishuPayload({ encryptKey, rawBody: body }),
        body,
      });
    try {
      const first = await post("first-key");
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toEqual({ account: "first" });
      const second = await post("second-key");
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({ account: "second" });
      expect(dispatchers[0]).toHaveBeenCalledTimes(1);
      expect(dispatchers[1]).toHaveBeenCalledTimes(1);

      const invalidJson = await post("second-key", "{not-json");
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.text()).toBe("Invalid JSON");
      expect(runtimes[1].log).toHaveBeenCalledWith(
        "feishu[shared-1]: webhook anomaly path=/hook-shared-accounts status=400 count=1",
      );
      expect(runtimes[0].log.mock.calls.flat().join(" ")).not.toContain("webhook anomaly");
      dispatchers[1].mockRejectedValueOnce(new Error("second dispatch failed"));
      const failed = await post("second-key");
      expect(failed.status).toBe(500);
      expect(failed.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      expect(await failed.text()).toBe("Internal Server Error");
      expect(runtimes[1].error).toHaveBeenCalledWith(
        "feishu[shared-1]: webhook handler error: Error: second dispatch failed",
      );
      expect(runtimes[0].error).not.toHaveBeenCalled();

      monitors.push(start(2, "second-key"));
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
      controllers[2].abort();
      await monitors[2];
      controllers[0].abort();
      await monitors[0];
      const removedKey = await post("first-key");
      expect(removedKey.status).toBe(401);
      expect(await removedKey.text()).toBe("Invalid signature");
      expect((await post("second-key")).status).toBe(200);
      expect(dispatchers[1]).toHaveBeenCalledTimes(4);
    } finally {
      legacyListener.value = undefined;
      for (const controller of controllers) {
        controller.abort();
      }
      await Promise.all(monitors);
    }
  });

  it("returns 401 for unsigned invalid json before parsing", async () => {
    await withSignedWebhook("invalid-json", async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Invalid signature");
    });
  });

  it("accepts signed callbacks near the timestamp skew window edge", async () => {
    await withSignedWebhook("skew-window-edge", async (url) => {
      const rawBody = JSON.stringify({ type: "url_verification", challenge: "challenge-token" });
      const response = await fetch(url, {
        method: "POST",
        body: rawBody,
        headers: signFeishuPayload({
          encryptKey: "encrypt_key",
          rawBody,
          timestamp: (Math.floor(Date.now() / 1000) - 3_300).toString(),
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      await expect(response.json()).resolves.toEqual({ challenge: "challenge-token" });
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
    const accountId = "durable-ack-ordering";
    const path = "/hook-e2e-durable-ack-ordering";
    const port = await getGatewayPort();
    const abortController = new AbortController();
    let releaseAdmission: (() => void) | undefined;
    const invoke = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseAdmission = resolve;
        }),
    );
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: { invoke } as never,
      invokeWebhookEvent: async () => {
        await invoke();
        return { kind: "durable", value: undefined };
      },
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitForWebhookRoute(url);

      const payload = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "evt-durable-ack-ordering-1" },
        event: { message: { chat_id: "oc_durable_ack_ordering" } },
      };
      let acceptedResponseReceived = false;
      const acceptedRequest = postSignedPayload(url, payload).then((response) => {
        acceptedResponseReceived = true;
        return response;
      });
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledTimes(1);
      });
      expect(acceptedResponseReceived).toBe(false);
      if (!releaseAdmission) {
        throw new Error("expected pending Feishu durable admission");
      }
      releaseAdmission();

      const accepted = await acceptedRequest;
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
    } finally {
      releaseAdmission?.();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("marks durably admitted message acks with the delivery-accepted header", async () => {
    await withSignedWebhook("signed-durable-ack", async (url) => {
      const payload = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "evt-durable-ack-1" },
        event: { message: { chat_id: "oc_durable_ack" } },
      };
      const response = await postSignedPayload(url, payload);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
    });
  });

  it("filters prototype-bearing keys without changing the Lark webhook envelope", async () => {
    const accountId = "prototype-guard";
    const path = "/hook-e2e-prototype-guard";
    const port = await getGatewayPort();
    const encryptKey = "encrypt_key";
    const account = createFeishuWebhookTestAccount(accountId, path);
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
    const abortController = new AbortController();
    const monitorPromise = monitorWebhook({
      account,
      accountId,
      abortSignal: abortController.signal,
      eventDispatcher,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const url = `http://127.0.0.1:${port}${path}`;
    await waitForWebhookRoute(url);

    const rawBody =
      '{"schema":"2.0","header":{"event_type":"test.prototype_guard"},"event":{"safe":"kept"},"headers":{"x-envelope-marker":"forged"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}';
    const headers = {
      ...signFeishuPayload({ encryptKey, rawBody }),
      "x-envelope-marker": "preserved",
    };

    try {
      const response = await fetch(url, { method: "POST", headers, body: rawBody });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(observedEnvelope).toBeDefined();
      if (!observedEnvelope) {
        throw new Error("expected Lark webhook envelope");
      }
      const envelopePrototype = Object.getPrototypeOf(observedEnvelope) as Record<string, unknown>;
      expect(Object.hasOwn(observedEnvelope, "headers")).toBe(false);
      expect(Object.hasOwn(envelopePrototype, "headers")).toBe(true);
      expect(
        (observedEnvelope.headers as Record<string, string | string[] | undefined>)[
          "x-envelope-marker"
        ],
      ).toBe("preserved");
      expect(observedEnvelope.event).toEqual({ safe: "kept" });
      expect(observedEnvelope.polluted).toBeUndefined();
      expect(Object.hasOwn(observedEnvelope, "__proto__")).toBe(false);
      expect(Object.hasOwn(observedEnvelope, "constructor")).toBe(false);
      expect(Object.hasOwn(observedEnvelope, "prototype")).toBe(false);
    } finally {
      abortController.abort();
      await monitorPromise;
    }
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

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        challenge: "encrypted-challenge-token",
      });
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
      settled = true;
      socket.destroy();
      reject(new Error("webhook request did not close within " + timeoutMs + "ms"));
    }, timeoutMs);
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(received);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (received.includes("Payload too large")) {
        finish();
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.write(
        "POST " +
          target.pathname +
          " HTTP/1.1\r\nHost: " +
          target.hostname +
          "\r\nContent-Type: application/json\r\nContent-Length: " +
          contentLength +
          "\r\nConnection: close\r\n\r\n" +
          (hold ? body.slice(0, -1) : body),
      );
    });
  });
  return { socket, response, finish: () => socket.write(body.slice(-1)), isClosed: () => settled };
}

async function waitForSlowBodyTimeoutResponse(url: string, timeoutMs: number) {
  const started = Date.now();
  const { response } = openWebhookRequest(url, '{"type":"url_verification"', {
    contentLength: 65536,
    timeoutMs,
  });
  return { body: await response, elapsedMs: Date.now() - started };
}

async function waitForOversizedBodyResponse(url: string) {
  return await openWebhookRequest(url, JSON.stringify({ payload: "x".repeat(70 * 1024) })).response;
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

function waitForWebhookResponseClose(): Promise<void> {
  const server = getGatewayServer();
  return new Promise<void>((resolve) => {
    server.once("request", (_req, res) => res.once("close", resolve));
  });
}

describe("Feishu webhook security hardening", () => {
  beforeEach(() => {
    webhookBodyTimeoutMs.value = 50;
  });
  it("rejects webhook mode without verificationToken", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildWebhookConfig({
      accountId: "missing-token",
      path: "/hook-missing-token",
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(
      /requires verificationToken/i,
    );
  });

  it("rejects webhook mode without encryptKey", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildWebhookConfig({
      accountId: "missing-encrypt-key",
      path: "/hook-missing-encrypt",
      verificationToken: "verify_token",
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(/requires encryptKey/i);
  });

  it("rejects oversized unsigned webhook bodies with 413 before signature verification", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const statusSink = vi.fn();
    await withSignedWebhook(
      "payload-too-large",
      async (url) => {
        statusSink.mockClear();
        const responseClosed = waitForWebhookResponseClose();
        const response = await waitForOversizedBodyResponse(url);

        expect(response).toContain("413 Payload Too Large");
        expect(response).toContain("Payload too large");
        expect(response).toMatch(/connection: close/i);
        await responseClosed;
        expect(
          runtime.log.mock.calls.filter(([message]) => message.includes("webhook anomaly")),
        ).toEqual([
          [
            "feishu[payload-too-large]: webhook anomaly path=/hook-payload-too-large status=413 count=1",
          ],
        ]);
        expect(statusSink).not.toHaveBeenCalled();
      },
      { runtime, statusSink },
    );
  });

  it("drops slow-body webhook requests within the tightened pre-auth timeout", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const statusSink = vi.fn();
    await withSignedWebhook(
      "slow-body-timeout",
      async (url) => {
        statusSink.mockClear();
        const responseClosed = waitForWebhookResponseClose();
        const result = await waitForSlowBodyTimeoutResponse(url, 1_000);
        expect(result.body).toContain("408 Request Timeout");
        expect(result.body).toContain("Request body timeout");
        expect(result.body).toMatch(/connection: close/i);
        expect(result.elapsedMs).toBeLessThan(500);
        await responseClosed;
        expect(
          runtime.log.mock.calls.filter(([message]) => message.includes("webhook anomaly")),
        ).toEqual([
          [
            "feishu[slow-body-timeout]: webhook anomaly path=/hook-slow-body-timeout status=408 count=1",
          ],
        ]);
        expect(statusSink).not.toHaveBeenCalled();
      },
      { runtime, statusSink },
    );
  });

  it("rejects excess concurrent pre-auth webhook reads and recovers capacity", async () => {
    webhookBodyTimeoutMs.value = 5_000;
    const accountId = "pre-auth-inflight";
    const path = "/hook-pre-auth-inflight";
    const port = await getGatewayPort();
    const abortController = new AbortController();
    const invokeWebhookEvent = vi.fn(async () => ({
      kind: "durable" as const,
      value: { accepted: true },
    }));
    const openRequests: Array<ReturnType<typeof openIncompleteWebhookRequest>> = [];
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
      invokeWebhookEvent,
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitForWebhookRoute(url);
      const server = getGatewayServer();
      const heldRequestsReceived = new Promise<void>((resolve) => {
        let requestCount = 0;
        const onRequest = () => {
          requestCount += 1;
          if (requestCount === 64) {
            server.off("request", onRequest);
            resolve();
          }
        };
        server.on("request", onRequest);
      });
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

      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.pre_auth_inflight" },
        event: {},
      });
      const recovered = await fetch(url, {
        method: "POST",
        headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
        body: rawBody,
      });

      expect(recovered.status).toBe(200);
      expect(recovered.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      expect(invokeWebhookEvent).toHaveBeenCalledTimes(1);
    } finally {
      for (const request of openRequests) {
        request.socket.destroy();
      }
      webhookBodyTimeoutMs.value = 50;
      abortController.abort();
      await monitorPromise;
    }
  });

  it("keeps pre-auth capacity independent for distinct trusted legacy listeners", async () => {
    preAuthInFlightLimit.value = 1;
    webhookBodyTimeoutMs.value = 5_000;
    const { EventDispatcher } =
      await vi.importActual<typeof import("@larksuiteoapi/node-sdk")>("@larksuiteoapi/node-sdk");
    const path = "/hook-legacy-pre-auth";
    const port = await getGatewayPort();
    const url = `http://127.0.0.1:${port}${path}`;
    const abortController = new AbortController();
    const monitors = [3000, 3001].map((legacyPort) => {
      const account = createFeishuWebhookTestAccount(`legacy-${legacyPort}`, path);
      return monitorWebhook({
        account: {
          ...account,
          config: { ...account.config, legacyWebhook: { port: legacyPort, host: "127.0.0.1" } },
        },
        accountId: account.accountId,
        abortSignal: abortController.signal,
        runtime: createRuntimeSpies(),
        eventDispatcher: new EventDispatcher({ encryptKey: "encrypt_key" }),
        invokeWebhookEvent: async () => ({ kind: "durable", value: { port: legacyPort } }),
      });
    });
    const heldReceived = new Promise<void>((resolve) => {
      getGatewayServer().once("request", () => resolve());
    });
    const heldClosed = waitForWebhookResponseClose();
    legacyListener.value = { port: 3000, host: "127.0.0.1" };
    const held = openIncompleteWebhookRequest(url);
    const body = JSON.stringify({ schema: "2.0", event: {} });
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody: body }),
        body,
      });
    try {
      await heldReceived;
      expect(held.isClosed()).toBe(false);
      legacyListener.value = { port: 3001, host: "127.0.0.1" };
      const second = await post();
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({ port: 3001 });
      legacyListener.value = { port: 3000, host: "127.0.0.1" };
      expect((await post()).status).toBe(429);
      expect(held.isClosed()).toBe(false);
    } finally {
      held.socket.destroy();
      await held.response;
      await heldClosed;
      legacyListener.value = undefined;
      abortController.abort();
      await Promise.all(monitors);
    }
  });

  it("releases pre-auth capacity before signed event dispatch", { timeout: 15_000 }, async () => {
    preAuthInFlightLimit.value = 1;
    const accountId = "pre-auth-dispatch";
    const path = "/hook-pre-auth-dispatch";
    const port = await getGatewayPort();
    const abortController = new AbortController();
    let releaseDispatch = () => {};
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const invokeWebhookEvent = vi.fn(async () => {
      await dispatchGate;
      return { kind: "durable" as const, value: { accepted: true } };
    });
    let signedRequest: Promise<Response> | undefined;
    const monitorPromise = monitorWebhook({
      account: createFeishuWebhookTestAccount(accountId, path),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
      invokeWebhookEvent,
    });

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      await waitForWebhookRoute(url);
      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "test.pre_auth_dispatch" },
        event: {},
      });
      signedRequest = fetch(url, {
        method: "POST",
        headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
        body: rawBody,
      });
      await vi.waitFor(() => expect(invokeWebhookEvent).toHaveBeenCalledOnce(), {
        timeout: 5_000,
        interval: 10,
      });

      const admittedInvalidSignature = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(admittedInvalidSignature.status).toBe(401);
      expect(invokeWebhookEvent).toHaveBeenCalledOnce();

      releaseDispatch();
      expect((await signedRequest).status).toBe(200);
    } finally {
      releaseDispatch();
      if (signedRequest) {
        await signedRequest.catch(() => undefined);
      }
      abortController.abort();
      await monitorPromise;
    }
  });

  it("rate limits webhook burst traffic with 429", async () => {
    await withSignedWebhook("rate-limit", async (url) => {
      let saw429 = false;
      for (let i = 0; i < 130; i += 1) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });
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
    const base = {
      accountId: "rate-limit-key",
      path: "/hook-rate-limit-key",
    };

    for (const address of ["127.0.0.1", "127.0.0.42", "::ffff:127.0.0.1", "::1"]) {
      expect(
        buildFeishuWebhookRateLimitKey({
          ...base,
          clientIp: resolveTestClientIp(address),
        }),
      ).toBe("rate-limit-key:/hook-rate-limit-key:loopback");
    }
  });

  it("keeps non-loopback and unknown webhook rate-limit key suffixes distinct", () => {
    const base = {
      accountId: "rate-limit-key",
      path: "/hook-rate-limit-key",
    };

    expect(buildFeishuWebhookRateLimitKey({ ...base, clientIp: "10.0.0.1" })).toBe(
      "rate-limit-key:/hook-rate-limit-key:10.0.0.1",
    );
    expect(buildFeishuWebhookRateLimitKey(base)).toBe(
      "rate-limit-key:/hook-rate-limit-key:unknown",
    );
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

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(await response.text()).toBe("Invalid signature");
      });
    },
  );
});
