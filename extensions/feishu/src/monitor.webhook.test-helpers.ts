// Feishu helper module supports monitor.webhook helpers behavior.
import crypto from "node:crypto";
import { createServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { canonicalizeWebhookRouteKey } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, onTestFinished, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { FeishuStatusSink, monitorFeishuProvider } from "./monitor.js";
import type { ResolvedFeishuAccount } from "./types.js";

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
    res.statusCode = 404;
    res.end("Not Found");
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
    await new Promise<void>((resolve, reject) => {
      gatewayServer.close((err) => (err ? reject(err) : resolve()));
    });
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
  webhookPath: string,
): ResolvedFeishuAccount {
  return {
    accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    domain: "feishu",
    encryptKey: "encrypt_key",
    verificationToken: "verify_token",
    config: FeishuConfigSchema.parse({
      enabled: true,
      connectionMode: "webhook",
      webhookPath,
      encryptKey: "encrypt_key",
      verificationToken: "verify_token",
    }),
  };
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

  return await new Promise<string>((resolve, reject) => {
    let response = "";
    const socket = createConnection({ host: "127.0.0.1", port: params.port }, () => {
      socket.end(
        `${params.method ?? "POST"} ${params.target} HTTP/1.1\r\nHost: localhost\r\n` +
          `${rawHeaders}\r\nContent-Length: ${Buffer.byteLength(params.rawBody)}\r\n` +
          `Connection: close\r\n\r\n${params.rawBody}`,
      );
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

export function buildWebhookConfig(params: {
  accountId: string;
  path: string;
  verificationToken?: string;
  encryptKey?: string;
}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          [params.accountId]: {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test", // pragma: allowlist secret
            connectionMode: "webhook",
            webhookPath: params.path,
            encryptKey: params.encryptKey,
            verificationToken: params.verificationToken,
          },
        },
      },
    },
  } as ClawdbotConfig;
}

export async function withRunningWebhookMonitor(
  params: {
    accountId: string;
    path: string;
    verificationToken: string;
    encryptKey: string;
    runtime?: RuntimeEnv;
    statusSink?: FeishuStatusSink;
  },
  monitor: typeof monitorFeishuProvider,
  run: (url: string) => Promise<void>,
) {
  const port = await getGatewayPort();
  const cfg = buildWebhookConfig(params);
  const abortController = new AbortController();
  const runtime = params.runtime ?? { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const monitorPromise = monitor({
    config: cfg,
    runtime,
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
