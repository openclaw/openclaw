import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { runHttpConnectionRequest } from "openclaw/plugin-sdk/webhook-request-guards";
import { canonicalizeWebhookRouteKey } from "openclaw/plugin-sdk/webhook-targets";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { registerNextcloudTalkWebhook } from "./monitor.js";
import type { NextcloudTalkWebhookTarget } from "./types.js";
import { inspectNextcloudTalkWebhookEnvelope } from "./webhook-spool-state.js";

export let webhookRegistry = createTestRegistry();
const unregisterTargets: Array<() => Promise<void>> = [];
const pending = new Set<Promise<void>>();
let portClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
const server = createServer((req, res) => {
  const task = runHttpConnectionRequest(
    req,
    async () => {
      const path = canonicalizeWebhookRouteKey(
        new URL(req.url ?? "/", "http://localhost").pathname,
      );
      const route = webhookRegistry.httpRoutes.find((entry) => entry.path === path);
      if (route) {
        await route.handler(req, res);
      } else {
        res.writeHead(404).end();
      }
    },
    res,
  ).catch(() => {
    res.destroy();
  });
  pending.add(task);
  void task.finally(() => pending.delete(task));
});

beforeEach(() => {
  webhookRegistry = createTestRegistry();
  setActivePluginRegistry(webhookRegistry);
});
beforeAll(async () => {
  portClaim = await acquireTestPortBlock({ offsets: [0] });
  const port = portClaim.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
});
afterEach(async () => {
  await Promise.all(unregisterTargets.splice(0).map((unregister) => unregister()));
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await portClaim?.release();
});

type StartWebhookServerParams = Omit<NextcloudTalkWebhookTarget, "onWebhook" | "secret"> & {
  secret?: string;
  onWebhook?: NextcloudTalkWebhookTarget["onWebhook"];
  onMessage?: (rawBody: string) => void | Promise<void>;
};

export async function startWebhookServer(params: StartWebhookServerParams) {
  const { onMessage, onWebhook, ...target } = params;
  const unregister = registerNextcloudTalkWebhook({
    ...target,
    secret: params.secret ?? "nextcloud-secret",
    onWebhook:
      onWebhook ??
      (async (rawBody) => {
        if (!inspectNextcloudTalkWebhookEnvelope(rawBody)) {
          return "ignored";
        }
        await onMessage?.(rawBody);
        return "accepted";
      }),
  });
  unregisterTargets.push(unregister);
  const address = server.address() as AddressInfo;
  return {
    server,
    waitForIdle: async () => {
      await Promise.all(pending);
    },
    webhookUrl: `http://127.0.0.1:${address.port}${params.path}`,
    stop: async () => unregister(),
  };
}
