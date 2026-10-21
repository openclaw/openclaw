import { createServer, type Server } from "node:http";
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
  let requestStarted: ReturnType<typeof createDeferred<void>>;
  const liveSockets = new Set<Socket>();

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
        requestStarted.resolve();
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
      socket.once("close", () => liveSockets.delete(socket));
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

  it.each(["backoff", "all", "webhook"] as const)("aborts during %s", async (phase) => {
    const controller = new AbortController();
    const requestsBefore = requestCount;
    const connectionsBefore = connectionCount;
    const backoffStarted = createDeferred<{ sleep: Promise<void> }>();
    requestStarted = createDeferred<void>();
    const realSleepWithAbort = runtimeEnv.sleepWithAbort;
    const sleepSpy =
      phase === "backoff"
        ? vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation((...args) => {
            // Register the real abort listener before signaling readiness.
            const sleep = realSleepWithAbort(...args);
            backoffStarted.resolve({ sleep });
            return sleep;
          })
        : undefined;
    stallMode = phase === "backoff" ? null : phase;
    const startedAt = Date.now();
    const promise = probeTelegram(`abort-${phase}-token`, 10_000, {
      apiRoot,
      ...(phase === "webhook" ? {} : { includeWebhookInfo: false }),
      abortSignal: controller.signal,
      // Isolate the outer retry loop from transport dispatcher fallbacks.
      network: { autoSelectFamily: false, dnsResultOrder: "verbatim" },
    });
    try {
      if (phase === "backoff") {
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
      } else {
        await requestStarted.promise;
        controller.abort();
      }
      expect((await promise).ok).toBe(false);
      expect(requestCount).toBe(requestsBefore + (phase === "webhook" ? 2 : 1));
      if (phase !== "webhook") {
        expect(connectionCount).toBe(connectionsBefore + 1);
      }
      if (phase !== "backoff") {
        expect(Date.now() - startedAt).toBeLessThan(1_000);
      }
    } finally {
      controller.abort();
      sleepSpy?.mockRestore();
      stallMode = null;
      await promise;
    }
  });
});
