import { once } from "node:events";
import http from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { fetchWithProviderHttpGuard } from "../plugin-sdk/provider-http.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { hasProviderTransportDispatcherPool } from "./provider-runtime-lifecycle.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

afterEach(async () => {
  await closeProviderTransportDispatcherPool();
  vi.unstubAllEnvs();
});

it("keeps request credentials separate and closes reused sockets at host shutdown", async () => {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  const sockets = new Set<Socket>();
  const closed: Promise<unknown>[] = [];
  await withServer(
    (request, response) => {
      if (!sockets.has(request.socket)) {
        sockets.add(request.socket);
        closed.push(once(request.socket, "close"));
      }
      request.resume();
      response.end(request.headers.authorization ?? "");
    },
    async (baseUrl) => {
      const request = async (credential: string) => {
        const result = await fetchWithProviderHttpGuard({
          url: baseUrl,
          policy: { allowPrivateNetwork: true },
          init: { headers: { Authorization: `Bearer ${credential}` } },
        });
        try {
          expect(await result.response.text()).toBe(`Bearer ${credential}`);
          return result.dispatcherReused;
        } finally {
          await result.release();
        }
      };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await request(`synthetic-key-${attempt}`)).toBe(attempt > 0);
      }
      expect(sockets.size).toBeLessThan(5);

      const closing = closeProviderTransportDispatcherPool();
      // Capture the closing generation before shutdown settles; this request
      // must use a caller-owned dispatcher instead of publishing another pool.
      const duringClosing = request("synthetic-key-during-shutdown");
      const [, reusedDuringClosing] = await Promise.all([closing, duringClosing]);
      expect(reusedDuringClosing).toBeUndefined();
      expect(hasProviderTransportDispatcherPool()).toBe(false);
      await Promise.all(closed);
      const previousConnections = sockets.size;
      expect(await request("synthetic-key-after-restart")).toBe(false);
      expect(sockets.size).toBe(previousConnections + 1);
    },
  );
});

it("closes the sockets of unfinished streaming responses at host shutdown", async () => {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  const sockets = new Set<Socket>();
  const closed: Promise<unknown>[] = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": synthetic heartbeat\n\n");
    // Intentionally leave the response streaming so the socket outlives shutdown.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closed.push(once(socket, "close"));
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const result = await fetchWithProviderHttpGuard({
      url: `${baseUrl}/stream`,
      policy: { allowPrivateNetwork: true },
      init: { headers: { accept: "text/event-stream" } },
    });
    // Read one chunk and keep the reader open: the response stays unfinished.
    const reader = result.response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(sockets.size).toBe(1);

    // Real, unmodified pool teardown while the stream is still active. Undici's
    // Agent[kClose] clears its child map before the children finish, so the
    // destroy fallback must still reach the tracked origin dispatcher.
    await closeProviderTransportDispatcherPool();
    await Promise.race([
      Promise.all(closed),
      new Promise((resolve) => {
        setTimeout(resolve, 2000);
      }),
    ]);
    expect(sockets.size).toBe(0);

    await reader.cancel().catch(() => undefined);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
