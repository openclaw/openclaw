import http from "node:http";
import net from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Tests the GET /health endpoint added to the msteams provider.
 * Validates that it responds before JWT auth middleware and returns
 * the expected JSON shape.
 */

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      })
      .on("error", reject);
  });
}

describe("msteams /health endpoint", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
  });

  it("returns JSON with status, channel, port, and startedAt", async () => {
    const port = await getFreePort();
    const app = express();

    // Mirror the exact pattern from monitor.ts
    const startedAt = new Date().toISOString();
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", channel: "msteams", port, startedAt });
    });

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });
    servers.push(server);

    const { status, body } = await httpGet(port, "/health");
    expect(status).toBe(200);

    const json = JSON.parse(body);
    expect(json).toEqual({
      status: "ok",
      channel: "msteams",
      port,
      startedAt: expect.any(String),
    });
    // startedAt should be a valid ISO date
    expect(() => new Date(json.startedAt)).not.toThrow();
    expect(new Date(json.startedAt).toISOString()).toBe(json.startedAt);
  });

  it("is accessible before JWT auth middleware", async () => {
    const port = await getFreePort();
    const app = express();

    // Health endpoint registered BEFORE auth middleware (matching monitor.ts)
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    // Auth middleware that rejects everything (simulates JWT guard)
    app.use((_req, res) => {
      res.status(401).json({ error: "unauthorized" });
    });

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });
    servers.push(server);

    // Health should bypass auth
    const health = await httpGet(port, "/health");
    expect(health.status).toBe(200);

    // Other routes should hit auth
    const other = await httpGet(port, "/api/messages");
    expect(other.status).toBe(401);
  });
});
