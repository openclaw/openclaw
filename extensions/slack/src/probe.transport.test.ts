// Slack tests cover real probe transport behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeSlack } from "./probe.js";

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const originalEnv = { ...process.env };

type TestServer = {
  apiUrl: string;
  sockets: Set<Socket>;
  close(): Promise<void>;
};

function restoreTestEnv() {
  for (const key of TEST_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
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
}

async function startServer(handler: Parameters<typeof createServer>[0]): Promise<TestServer> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    sockets,
    close: () => closeServer(server, sockets),
  };
}

function clearSlackTransportEnv() {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  restoreTestEnv();
});

describe("probeSlack transport", () => {
  it("closes the request socket when the probe deadline expires", async () => {
    clearSlackTransportEnv();
    let requestCount = 0;
    const server = await startServer((request) => {
      requestCount += 1;
      request.resume();
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;

      await expect(probeSlack("probe-token", 100)).resolves.toMatchObject({ ok: false });
      expect(requestCount).toBe(1);
      await expect.poll(() => server.sockets.size, { timeout: 1000 }).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("rejects rate limits without waiting through Retry-After", async () => {
    clearSlackTransportEnv();
    let requestCount = 0;
    const server = await startServer((request, response) => {
      requestCount += 1;
      request.resume();
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "5",
      });
      response.end(`${JSON.stringify({ ok: false, error: "ratelimited" })}\n`);
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;
      const start = performance.now();

      await expect(probeSlack("probe-token", 10_000)).resolves.toMatchObject({ ok: false });

      expect(performance.now() - start).toBeLessThan(2500);
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("aborts a response that keeps trickling bytes past the probe deadline", async () => {
    clearSlackTransportEnv();
    let requestCount = 0;
    const server = await startServer((request, response) => {
      requestCount += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const trickle = setInterval(() => response.write(" "), 25);
      const finish = setTimeout(() => {
        clearInterval(trickle);
        response.end(`${JSON.stringify({ ok: true })}\n`);
      }, 750);
      response.once("close", () => {
        clearInterval(trickle);
        clearTimeout(finish);
      });
    });
    try {
      process.env.SLACK_API_URL = server.apiUrl;
      const start = performance.now();

      await expect(probeSlack("probe-token", 100)).resolves.toMatchObject({ ok: false });

      expect(performance.now() - start).toBeLessThan(500);
      expect(requestCount).toBe(1);
      await expect.poll(() => server.sockets.size, { timeout: 1000 }).toBe(0);
    } finally {
      await server.close();
    }
  });
});
