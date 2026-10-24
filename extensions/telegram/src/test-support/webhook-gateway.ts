import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { canonicalizeWebhookRouteKey } from "openclaw/plugin-sdk/webhook-ingress";
import { vi } from "vitest";
import * as telegramIngressFactory from "../telegram-ingress-drain-factory.js";

type StartWebhook = typeof import("../webhook.js").startTelegramWebhook;
type StartWebhookOptions = Omit<Parameters<StartWebhook>[0], "token" | "abortSignal">;
type Ingress = ReturnType<typeof telegramIngressFactory.createTelegramTransportIngressMonitor>;

export function getServerPort(server: Server): number {
  const address = server.address();
  assert(address && typeof address !== "string", "no addr");
  return address.port;
}

export function webhookUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

export function createTelegramWebhookTestGateway(options: {
  token: string;
  queueScope: () => { stateDir: string; accountId: string };
}) {
  let registry = createEmptyPluginRegistry();
  let production: StartWebhook;
  const pendingRequests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = registry.httpRoutes.find(
      (entry) => canonicalizeWebhookRouteKey(entry.path) === canonicalizeWebhookRouteKey(path),
    );
    if (route) {
      const requestTask = Promise.resolve(route.handler(req, res)).then(
        () => undefined,
        () => void res.writeHead(500).end(),
      );
      pendingRequests.add(requestTask);
      void requestTask.finally(() => pendingRequests.delete(requestTask));
    } else {
      res.writeHead(404).end();
    }
  });
  const startWebhook = async (params: Parameters<StartWebhook>[0]) => ({
    ...(await production({
      ...params,
      publicUrl:
        params.publicUrl ?? webhookUrl(getServerPort(server), params.path ?? "/telegram-webhook"),
    })),
    server,
  });

  return {
    server,
    pendingRequests,
    get registry() {
      return registry;
    },
    async listen() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      production = (await import("../webhook.js")).startTelegramWebhook;
    },
    async close() {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
    resetRegistry() {
      registry = createEmptyPluginRegistry();
      setActivePluginRegistry(registry);
    },
    startWebhook,
    withWebhook: async <T>(
      params: StartWebhookOptions,
      run: (ctx: { server: Server; port: number; ingress: Ingress }) => Promise<T>,
    ): Promise<T> => {
      using createIngress = vi.spyOn(
        telegramIngressFactory,
        "createTelegramTransportIngressMonitor",
      );
      const abort = new AbortController();
      const started = await startWebhook({
        token: options.token,
        abortSignal: abort.signal,
        ...options.queueScope(),
        ...params,
      });
      try {
        const result = createIngress.mock.results.at(-1);
        assert(result?.type === "return", "Expected the started webhook's ingress monitor");
        return await run({ server, port: getServerPort(server), ingress: result.value });
      } finally {
        await started.stop();
        abort.abort();
      }
    },
  };
}
