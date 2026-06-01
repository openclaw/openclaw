import crypto from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import { clearFeishuWebhookRateLimitStateForTest, httpServers } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import { getFreePort } from "./monitor.webhook.test-helpers.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

async function waitForWebhookServer(accountId: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const server = httpServers.get(accountId);
    if (server?.listening) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`feishu webhook server did not start for accountId=${accountId}`);
}

function buildSignedHeaders(params: {
  payload: Record<string, unknown>;
  encryptKey: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = params.timestamp ?? String(Date.now());
  const nonce = params.nonce ?? "nonce-test";
  const signature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + params.encryptKey + JSON.stringify(params.payload))
    .digest("hex");

  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

async function startWebhookServer(params: {
  accountId: string;
  port: number;
  path: string;
  encryptKey: string;
  eventDispatcherInvoke: ReturnType<typeof vi.fn>;
}): Promise<{ stop: () => Promise<void> }> {
  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  const account: ResolvedFeishuAccount = {
    accountId: params.accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "app_test",
    appSecret: "secret_test", // pragma: allowlist secret
    encryptKey: params.encryptKey,
    domain: "feishu",
    config: {
      webhookHost: "127.0.0.1",
      webhookPort: params.port,
      webhookPath: params.path,
    } as unknown as FeishuConfig,
  };

  const abortController = new AbortController();
  const monitorPromise = monitorWebhook({
    account,
    accountId: params.accountId,
    runtime,
    abortSignal: abortController.signal,
    eventDispatcher: { invoke: params.eventDispatcherInvoke } as any,
  });

  await waitForWebhookServer(params.accountId);

  return {
    stop: async () => {
      abortController.abort();
      await monitorPromise;
    },
  };
}

async function sendRawHttpRequest(params: { port: number; request: string }): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: params.port }, () => {
      socket.write(params.request);
    });

    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

afterEach(() => {
  clearFeishuWebhookRateLimitStateForTest();
  for (const server of httpServers.values()) {
    server.close();
  }
  httpServers.clear();
});

describe("monitorWebhook", () => {
  it("rejects requests on non-configured paths before signature verification/dispatch", async () => {
    const accountId = "account-path-check";
    const port = await getFreePort();
    const path = "/expected-feishu-hook";
    const encryptKey = "encrypt_test"; // pragma: allowlist secret

    const invokeMock = vi.fn(async () => ({ ok: true }));
    const server = await startWebhookServer({
      accountId,
      port,
      path,
      encryptKey,
      eventDispatcherInvoke: invokeMock,
    });

    const payload = { type: "event_callback", event: { foo: "bar" } };
    const headers = buildSignedHeaders({ payload, encryptKey });

    const response = await fetch(`http://127.0.0.1:${port}/wrong-path`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(invokeMock).not.toHaveBeenCalled();

    await server.stop();
  });

  it("continues to accept requests on the configured path", async () => {
    const accountId = "account-path-accept";
    const port = await getFreePort();
    const path = "/expected-feishu-hook";
    const encryptKey = "encrypt_test"; // pragma: allowlist secret

    const invokeMock = vi.fn(async () => ({ ok: true }));
    const server = await startWebhookServer({
      accountId,
      port,
      path,
      encryptKey,
      eventDispatcherInvoke: invokeMock,
    });

    const payload = { type: "event_callback", event: { foo: "bar" } };
    const headers = buildSignedHeaders({ payload, encryptKey });

    const response = await fetch(`http://127.0.0.1:${port}${path}?source=test`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it("does not treat //host/path request targets as matching the configured webhook path", async () => {
    const accountId = "account-path-network-reference";
    const port = await getFreePort();
    const path = "/expected-feishu-hook";
    const encryptKey = "encrypt_test"; // pragma: allowlist secret

    const invokeMock = vi.fn(async () => ({ ok: true }));
    const server = await startWebhookServer({
      accountId,
      port,
      path,
      encryptKey,
      eventDispatcherInvoke: invokeMock,
    });

    const payload = { type: "event_callback", event: { foo: "bar" } };
    const headers = buildSignedHeaders({ payload, encryptKey });

    const response = await fetch(`http://127.0.0.1:${port}//evil${path}?source=test`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(invokeMock).not.toHaveBeenCalled();

    await server.stop();
  });

  it("normalizes configured webhook paths before matching incoming requests", async () => {
    const accountId = "account-path-normalized";
    const port = await getFreePort();
    const configuredPath = " expected-feishu-hook/ ";
    const requestPath = "/expected-feishu-hook";
    const encryptKey = "encrypt_test"; // pragma: allowlist secret

    const invokeMock = vi.fn(async () => ({ ok: true }));
    const server = await startWebhookServer({
      accountId,
      port,
      path: configuredPath,
      encryptKey,
      eventDispatcherInvoke: invokeMock,
    });

    const payload = { type: "event_callback", event: { foo: "bar" } };
    const headers = buildSignedHeaders({ payload, encryptKey });

    const response = await fetch(`http://127.0.0.1:${port}${requestPath}?source=test`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it("returns 400 instead of throwing on malformed absolute-form request targets", async () => {
    const accountId = "account-path-malformed";
    const port = await getFreePort();
    const encryptKey = "encrypt_test"; // pragma: allowlist secret

    const invokeMock = vi.fn(async () => ({ ok: true }));
    const server = await startWebhookServer({
      accountId,
      port,
      path: "/expected-feishu-hook",
      encryptKey,
      eventDispatcherInvoke: invokeMock,
    });

    const response = await sendRawHttpRequest({
      port,
      request:
        "POST http://[::1 HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n",
    });

    expect(response).toContain("HTTP/1.1 400 Bad Request");
    expect(response).toContain("Bad Request");
    expect(invokeMock).not.toHaveBeenCalled();

    await server.stop();
  });
});
