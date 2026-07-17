// Real-socket proof that the startup probe retry loop stops when the owning
// abortSignal fires. Production Telegram transport talks to a local stub that
// resets the first connection, then aborts before the retry delay elapses.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeTelegram, resetTelegramProbeFetcherCacheForTests } from "./probe.js";

describe("probeTelegram startup retry loop honors abortSignal", () => {
  let server: Server;
  let apiRoot: string;
  let requestCount = 0;
  let connectionCount = 0;
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

    server = createServer((_req, res) => {
      requestCount += 1;
      // Abruptly terminate the first request so the probe enters its retry
      // backoff. The abort controller fires while sleepWithAbort is waiting,
      // which must prevent a second connection attempt.
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
    resetTelegramProbeFetcherCacheForTests();
    vi.unstubAllEnvs();
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("stops retrying getMe after abortSignal fires during the backoff", async () => {
    const abortController = new AbortController();
    const previousRequestCount = requestCount;
    const previousConnectionCount = connectionCount;

    // Abort once the first connection has been torn down and the probe is
    // sleeping before its retry. This must happen before the retry delay
    // would naturally elapse (timeoutMs/5, capped at 1000ms).
    server.once("connection", () => {
      setTimeout(() => abortController.abort(), 50);
    });

    const result = await probeTelegram("abort-test-token", 10_000, {
      apiRoot,
      includeWebhookInfo: false,
      abortSignal: abortController.signal,
    });

    expect(result.ok).toBe(false);
    expect(requestCount).toBe(previousRequestCount + 1);
    expect(connectionCount).toBe(previousConnectionCount + 1);
  });
});
