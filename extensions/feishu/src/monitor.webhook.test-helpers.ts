// Feishu helper module supports monitor.webhook helpers behavior.
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import type { FeishuStatusSink, monitorFeishuProvider } from "./monitor.js";
import type { ResolvedFeishuAccount } from "./types.js";

const WEBHOOK_READY_MAX_ATTEMPTS = 200;
const WEBHOOK_READY_RETRY_DELAY_MS = 50;
const runningWebhookMonitors = new Map<AbortController, Promise<void>>();

export function createFeishuWebhookTestAccount(
  accountId: string,
  port: number,
  webhookPath: string,
): ResolvedFeishuAccount {
  return {
    accountId,
    encryptKey: "encrypt_key",
    config: {
      enabled: true,
      connectionMode: "webhook",
      webhookHost: "127.0.0.1",
      webhookPort: port,
      webhookPath,
    },
  } as ResolvedFeishuAccount;
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

export async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

export async function waitUntilServerReady(url: string): Promise<void> {
  for (let i = 0; i < WEBHOOK_READY_MAX_ATTEMPTS; i += 1) {
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init: { method: "GET" },
        policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
        auditContext: "feishu-webhook-test-ready",
      });
      try {
        if (response.status >= 200 && response.status < 500) {
          return;
        }
      } finally {
        await release();
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WEBHOOK_READY_RETRY_DELAY_MS);
    });
  }
  throw new Error(`server did not start: ${url}`);
}

export function buildWebhookConfig(params: {
  accountId: string;
  path: string;
  port: number;
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
            webhookHost: "127.0.0.1",
            webhookPort: params.port,
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
  const abortController = new AbortController();
  const operation = (async () => {
    const port = await getFreePort();
    abortController.signal.throwIfAborted();
    const cfg = buildWebhookConfig({
      accountId: params.accountId,
      path: params.path,
      port,
      encryptKey: params.encryptKey,
      verificationToken: params.verificationToken,
    });
    const ready = createDeferred<void>();
    const runtime = params.runtime ?? { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const monitorPromise = monitor({
      config: cfg,
      runtime,
      abortSignal: abortController.signal,
      accountId: params.accountId,
      statusSink: (patch) => {
        params.statusSink?.(patch);
        if (patch.connected === true && patch.lifecycle === "ready") {
          ready.resolve();
        }
      },
    });
    try {
      // The transport emits readiness from server.listen; assertion callbacks run once.
      await Promise.race([
        ready.promise,
        monitorPromise.then(() => {
          throw new Error("webhook monitor stopped before readiness");
        }),
      ]);
      abortController.signal.throwIfAborted();
      await run(`http://127.0.0.1:${port}${params.path}`);
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  })();
  runningWebhookMonitors.set(abortController, operation);
  try {
    await operation;
  } finally {
    runningWebhookMonitors.delete(abortController);
  }
}

// Consumers join callback and monitor work before clearing transport state or closing the DB.
export async function cleanupRunningWebhookMonitors(): Promise<void> {
  const pending = [...runningWebhookMonitors];
  for (const [controller] of pending) {
    controller.abort();
  }
  const results = await Promise.allSettled(pending.map(([, operation]) => operation));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "webhook fixture cleanup failed");
  }
}
