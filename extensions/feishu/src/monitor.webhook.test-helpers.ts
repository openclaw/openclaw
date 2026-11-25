import crypto from "node:crypto";
import { createServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { canonicalizeWebhookRouteKey } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, expect, onTestFinished, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { FeishuStatusSink, monitorFeishuProvider } from "./monitor.js";
import type { ResolvedFeishuAccount } from "./types.js";

type WebhookConfigParams = {
  accountId: string;
  path: string;
  verificationToken?: string;
  encryptKey?: string;
};
const webhookAuth = { encryptKey: "encrypt_key", verificationToken: "verify_token" };
const webhookDefaults = { enabled: true, connectionMode: "webhook" } as const;
const registry = createEmptyPluginRegistry();
const pendingRoutes = new Map<string, Set<() => void>>();
const routeSplice = registry.httpRoutes.splice.bind(registry.httpRoutes);
registry.httpRoutes.splice = (
  start: number,
  deleteCount?: number,
  ...items: typeof registry.httpRoutes
) => {
  const result = routeSplice(start, deleteCount ?? registry.httpRoutes.length - start, ...items);
  for (const route of registry.httpRoutes) {
    for (const resolve of pendingRoutes.get(route.path) ?? []) {
      resolve();
    }
    pendingRoutes.delete(route.path);
  }
  return result;
};
const gatewayServer = createServer((req, res) => {
  const route = registry.httpRoutes.find(
    (entry) => entry.path === canonicalizeWebhookRouteKey(req.url ?? "/"),
  );
  if (!route) {
    res.writeHead(404).end("Not Found");
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((err: unknown) => {
    res.statusCode = 500;
    res.end(String(err));
  });
});
let gatewayPort: Promise<number> | undefined;

export function getGatewayServer() {
  return gatewayServer;
}

export function getGatewayPort(): Promise<number> {
  setActivePluginRegistry(registry);
  gatewayPort ??= new Promise((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(0, "127.0.0.1", () => {
      gatewayServer.removeListener("error", reject);
      resolve((gatewayServer.address() as AddressInfo).port);
    });
  });
  return gatewayPort;
}

afterAll(async () => {
  gatewayServer.closeAllConnections();
  if (gatewayServer.listening) {
    await promisify(gatewayServer.close.bind(gatewayServer))();
  }
});

export function waitForWebhookRoute(url: string): Promise<void> {
  const path = canonicalizeWebhookRouteKey(new URL(url).pathname);
  if (registry.httpRoutes.some((route) => route.path === path)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiters = pendingRoutes.get(path) ?? new Set();
    waiters.add(resolve);
    pendingRoutes.set(path, waiters);
  });
}

export function createFeishuWebhookTestAccount(
  accountId: string,
  webhookPath = `/hook-${accountId}`,
): ResolvedFeishuAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    domain: "feishu",
    ...webhookAuth,
    config: FeishuConfigSchema.parse({
      ...webhookDefaults,
      webhookPath,
      ...webhookAuth,
    }),
  };
}

export function createHeldWebhookDispatch<T>(value: T) {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const handler = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return value;
  });
  return { started: started.promise, release: release.resolve, handler };
}

export async function expectWebhookJson(response: Response, value: unknown) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(value);
}

export function waitForWebhookResponseClose(): Promise<void> {
  return new Promise((resolve) => {
    gatewayServer.once("request", (_req, res) => res.once("close", resolve));
  });
}

export function signFeishuPayload(params: {
  encryptKey: string;
  rawBody: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = params.nonce ?? "nonce-test";
  const signature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + params.encryptKey + params.rawBody)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

export async function postSignedPayload(url: string, payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: signFeishuPayload({ encryptKey: "encrypt_key", rawBody }),
      body: rawBody,
    },
    policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
    auditContext: "feishu-webhook-test",
  });
  onTestFinished(release);
  return response;
}

export async function sendRawSignedFeishuRequest(params: {
  port: number;
  target: string;
  method?: string;
  rawBody: string;
  headers: Record<string, string>;
}): Promise<string> {
  const rawHeaders = Object.entries(params.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");

  const socket = createConnection({ host: "127.0.0.1", port: params.port }, () => {
    socket.end(
      `${params.method ?? "POST"} ${params.target} HTTP/1.1\r\nHost: localhost\r\n` +
        `${rawHeaders}\r\nContent-Length: ${Buffer.byteLength(params.rawBody)}\r\n` +
        `Connection: close\r\n\r\n${params.rawBody}`,
    );
  });
  return text(socket);
}

export function buildWebhookConfig(params: WebhookConfigParams): ClawdbotConfig {
  const accounts = {
    [params.accountId]: {
      ...webhookDefaults,
      appId: "cli_test",
      appSecret: "secret_test", // pragma: allowlist secret
      webhookPath: params.path,
      encryptKey: params.encryptKey,
      verificationToken: params.verificationToken,
    },
  };
  return { channels: { feishu: { enabled: true, accounts } } } as ClawdbotConfig;
}

export async function withRunningWebhookMonitor(
  params: Required<WebhookConfigParams> & {
    runtime?: RuntimeEnv;
    statusSink?: FeishuStatusSink;
  },
  monitor: typeof monitorFeishuProvider,
  run: (url: string) => Promise<void>,
) {
  const port = await getGatewayPort();
  const abortController = new AbortController();
  const monitorPromise = monitor({
    config: buildWebhookConfig(params),
    runtime: params.runtime ?? { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    abortSignal: abortController.signal,
    accountId: params.accountId,
    statusSink: params.statusSink,
  });
  const url = `http://127.0.0.1:${port}${params.path}`;
  try {
    await Promise.race([
      waitForWebhookRoute(url),
      monitorPromise.then(() => {
        throw new Error("monitor stopped before route registration");
      }),
    ]);
    await run(url);
  } finally {
    abortController.abort();
    await monitorPromise;
  }
}
