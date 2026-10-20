// Real-socket proof that the startup probe stops when the owning abortSignal
// fires during either an active request or retry backoff.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeTelegram } from "./probe.js";

describe("probeTelegram startup retry loop honors abortSignal", () => {
  let server: Server;
  let apiRoot: string;
  let requestCount = 0;
  let connectionCount = 0;
  let stallMode: "all" | "webhook" | null = null;
  const liveSockets = new Set<Socket>();
  function startProbe(token: string, webhook = false) {
    const controller = new AbortController();
    return {
      controller,
      requestsBefore: requestCount,
      connectionsBefore: connectionCount,
      promise: probeTelegram(token, 10_000, {
        apiRoot,
        ...(webhook ? {} : { includeWebhookInfo: false }),
        abortSignal: controller.signal,
        // Isolate the outer retry loop from transport dispatcher fallbacks.
        network: { autoSelectFamily: false, dnsResultOrder: "verbatim" },
      }),
    };
  }

  async function abortStalledRequest(webhook: boolean) {
    const requestStarted = createDeferred<void>();
    const onRequest = (req: IncomingMessage) => {
      if (!webhook || req.url?.endsWith("/getWebhookInfo")) {
        server.off("request", onRequest);
        requestStarted.resolve();
      }
    };
    server.on("request", onRequest);
    stallMode = webhook ? "webhook" : "all";
    const startedAt = Date.now();
    const probe = startProbe(
      webhook ? "abort-webhook-request-token" : "abort-active-request-token",
      webhook,
    );
    await requestStarted.promise;
    probe.controller.abort();
    expect((await probe.promise).ok).toBe(false);
    stallMode = null;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(requestCount).toBe(probe.requestsBefore + (webhook ? 2 : 1));
    if (!webhook) {
      expect(connectionCount).toBe(probe.connectionsBefore + 1);
    }
  }

  beforeAll(async () => {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_PROXY_URL",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
      "OPENCLAW_DEBUG_PROXY_URL",
    ]) {
      vi.stubEnv(name, "");
    }

    server = createServer((req, res) => {
      requestCount += 1;
      if (
        stallMode === "all" ||
        (stallMode === "webhook" && req.url?.endsWith("/getWebhookInfo"))
      ) {
        return;
      }
      if (stallMode === "webhook") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }));
        return;
      }
      // Force outer retry backoff; abort must prevent the second connection.
      res.socket?.destroy();
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      liveSockets.add(socket);
      socket.once("close", () => {
        liveSockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("stops retrying getMe after abortSignal fires during the backoff", async () => {
    const backoffStarted = createDeferred<{ sleep: Promise<void> }>();
    const realSleepWithAbort = runtimeEnv.sleepWithAbort;
    const sleepSpy = vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation((...args) => {
      // The real sleep registers its abort listener synchronously. A TCP connection
      // alone does not prove the request failed or that retry backoff has started.
      const sleep = realSleepWithAbort(...args);
      backoffStarted.resolve({ sleep });
      return sleep;
    });

    const { controller, promise, requestsBefore, connectionsBefore } =
      startProbe("abort-test-token");

    try {
      const { sleep } = await Promise.race([
        backoffStarted.promise,
        promise.then(() => {
          throw new Error("Probe completed before entering retry backoff");
        }),
      ]);
      controller.abort();
      await expect(sleep).rejects.toMatchObject({
        name: "AbortError",
        cause: controller.signal.reason,
      });
      const result = await promise;

      expect(result.ok).toBe(false);
      expect(requestCount).toBe(requestsBefore + 1);
      expect(connectionCount).toBe(connectionsBefore + 1);
    } finally {
      controller.abort();
      sleepSpy.mockRestore();
      await promise;
    }
  });

  it("aborts a stalled in-flight getMe request", async () => {
    await abortStalledRequest(false);
  });

  it("does not report success when aborting a stalled webhook-info request", async () => {
    await abortStalledRequest(true);
  });
});
