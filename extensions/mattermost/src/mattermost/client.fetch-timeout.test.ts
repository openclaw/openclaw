// Mattermost tests cover real REST client timeout behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  fetchMattermostMe,
} from "./client.js";

type HangingMattermostServer = {
  baseUrl: string;
  close: () => Promise<void>;
  requestCount: () => number;
  waitForRequest: () => Promise<void>;
};

const activeServers: HangingMattermostServer[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startHangingMattermostServer(): Promise<HangingMattermostServer> {
  let requests = 0;
  const sockets = new Set<Socket>();
  const requestWaiters: Array<() => void> = [];
  const server: Server = createServer((req) => {
    requests += 1;
    req.resume();
    for (const resolve of requestWaiters.splice(0)) {
      resolve();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const started: HangingMattermostServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    requestCount: () => requests,
    waitForRequest: async () => {
      if (requests > 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        requestWaiters.push(resolve);
      });
    },
  };
  activeServers.push(started);
  return started;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  { status: "resolved"; value: T } | { status: "rejected"; error: unknown } | { status: "pending" }
> {
  return await Promise.race([
    promise.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    delay(timeoutMs).then(() => ({ status: "pending" as const })),
  ]);
}

afterEach(async () => {
  const servers = activeServers.splice(0);
  await Promise.all(servers.map((server) => server.close()));
});

describe("Mattermost REST client fetch timeout", () => {
  it("rejects a hanging real loopback request at the configured client timeout", async () => {
    const server = await startHangingMattermostServer();
    const client = createMattermostClient({
      baseUrl: server.baseUrl,
      botToken: "bot-token",
      allowPrivateNetwork: true,
      timeoutMs: 50,
    });

    const request = fetchMattermostMe(client);
    await server.waitForRequest();
    const result = await settleWithin(request, 750);

    expect(server.requestCount()).toBeGreaterThan(0);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error(`expected timeout rejection, got ${result.status}`);
    }
    expect(errorName(result.error)).toMatch(/^(AbortError|TimeoutError)$/);
  });

  it("preserves a caller AbortSignal while applying the default request timeout", async () => {
    const server = await startHangingMattermostServer();
    const client = createMattermostClient({
      baseUrl: server.baseUrl,
      botToken: "bot-token",
      allowPrivateNetwork: true,
      timeoutMs: 30_000,
    });
    const controller = new AbortController();

    const request = client.request("/users/me", { signal: controller.signal });
    await server.waitForRequest();
    controller.abort();
    const result = await settleWithin(request, 750);

    expect(server.requestCount()).toBeGreaterThan(0);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error(`expected caller abort rejection, got ${result.status}`);
    }
    expect(errorName(result.error)).toMatch(/^(AbortError|TimeoutError)$/);
  });

  it("preserves configured DM retry timeouts longer than the client default", async () => {
    const server = await startHangingMattermostServer();
    const client = createMattermostClient({
      baseUrl: server.baseUrl,
      botToken: "bot-token",
      allowPrivateNetwork: true,
      timeoutMs: 50,
    });

    const request = createMattermostDirectChannelWithRetry(client, ["bot-user", "dm-user"], {
      maxRetries: 0,
      timeoutMs: 250,
    });
    request.catch(() => undefined);
    await server.waitForRequest();

    expect(await settleWithin(request, 120)).toEqual({ status: "pending" });
    const result = await settleWithin(request, 600);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error(`expected DM retry timeout rejection, got ${result.status}`);
    }
    expect(errorName(result.error)).toMatch(/^(AbortError|TimeoutError)$/);
  });
});
