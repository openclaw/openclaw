import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPreRouterHook } from "./pre-router.js";

/**
 * Integration-style fixture: spin up a real local HTTP server that
 * behaves like the orbit-mcp `/skill-matcher/dispatch` endpoint, then
 * exercise `runPreRouterHook` against it. This proves the wire
 * contract works against an actual TCP/JSON round-trip — not just
 * mocked `fetch`.
 *
 * Lives alongside the unit tests so CI exercises both paths.
 * Does not depend on Python — just confirms the HTTP shape.
 */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server | undefined;
let handler: Handler | undefined;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!handler) {
      res.statusCode = 500;
      res.end("no handler");
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/skill-matcher/dispatch`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
});

afterEach(() => {
  handler = undefined;
});

const payload = {
  prompt: "help",
  channel: "C0123",
  user: "U0123",
  ts: "1717423420.000100",
};

describe("runPreRouterHook against a real local HTTP server", () => {
  it("returns the response body on a real 200 OK hit", async () => {
    let receivedBody: unknown;
    handler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            matched: true,
            response: "real http hit",
            pattern_id: "help",
            latency_ms: 7.5,
          }),
        );
      });
    };

    const result = await runPreRouterHook(payload, { readUrl: () => baseUrl });
    expect(result).toBe("real http hit");
    expect(receivedBody).toEqual(payload);
  });

  it("falls through to null on real HTTP 503", async () => {
    handler = (_req, res) => {
      res.statusCode = 503;
      res.end("Service Unavailable");
    };
    const result = await runPreRouterHook(payload, { readUrl: () => baseUrl });
    expect(result).toBeNull();
  });

  it("falls through to null when the server hangs longer than the timeout", async () => {
    // Server intentionally never responds. Hook should abort after
    // its configured timeout (50ms here) and return null without
    // hanging the test.
    handler = (_req, _res) => {
      // hold open indefinitely
    };
    const start = Date.now();
    const result = await runPreRouterHook(payload, {
      readUrl: () => baseUrl,
      readTimeoutMs: () => 50,
    });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Sanity: timeout fired within a reasonable budget. Generous
    // upper bound to avoid flakiness on loaded CI.
    expect(elapsed).toBeLessThan(2000);
  });

  it("falls through to null on truly malformed (non-JSON) body", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end("definitely not json");
    };
    const result = await runPreRouterHook(payload, { readUrl: () => baseUrl });
    expect(result).toBeNull();
  });
});
