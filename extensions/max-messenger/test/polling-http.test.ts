/**
 * Unit tests for polling-http. Drives the wrapper against ephemeral
 * `node:http` servers so error classification and Retry-After parsing get
 * end-to-end coverage without depending on the fake-MAX harness's full
 * scenario surface.
 */
import { once } from "node:events";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  NetworkError,
  parseRetryAfterMs,
  pollingHttpRequest,
  RetryAfterError,
  ServerError,
  TimeoutError,
  UnauthorizedError,
} from "../src/polling/polling-http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((err: unknown) => {
      if (!res.destroyed) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "test_error", message: String(err) }));
      }
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === "string") {
    throw new Error("test server address missing");
  }
  return `http://127.0.0.1:${addr.port}`;
}

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds (RFC 7231 §7.1.3 sec-int form)", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("5")).toBe(5_000);
    expect(parseRetryAfterMs(" 30 ")).toBe(30_000);
  });

  it("parses HTTP-date as ms-from-now (clamped at 0 when the date is in the past)", () => {
    const future = new Date(Date.UTC(2099, 0, 1));
    const past = new Date(Date.UTC(2000, 0, 1));
    const now = (): number => Date.UTC(2026, 4, 4);
    expect(parseRetryAfterMs(future.toUTCString(), now)).toBeGreaterThan(0);
    expect(parseRetryAfterMs(past.toUTCString(), now)).toBe(0);
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});

describe("pollingHttpRequest", () => {
  it("returns the parsed JSON body on 2xx and forwards Authorization + query params", async () => {
    let observedAuth: string | undefined;
    let observedUrl: string | undefined;
    const url = await startServer((req, res) => {
      observedAuth = req.headers.authorization ?? undefined;
      observedUrl = req.url ?? undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, marker: 99 }));
    });
    const body = await pollingHttpRequest<{ ok: boolean; marker: number }>({
      apiRoot: url,
      path: "/updates",
      method: "GET",
      token: "test-token",
      query: { marker: 12, timeout: 30, limit: 50 },
    });
    expect(body).toEqual({ ok: true, marker: 99 });
    expect(observedAuth).toBe("test-token");
    expect(observedUrl).toBe("/updates?marker=12&timeout=30&limit=50");
  });

  it("serializes JSON bodies with Content-Type application/json on POST", async () => {
    let observedBody = "";
    let observedContentType: string | undefined;
    const url = await startServer((req, res) => {
      observedContentType = req.headers["content-type"] ?? undefined;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        observedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: { body: { mid: "mid-1" } } }));
      });
    });
    const body = await pollingHttpRequest<{ message: { body: { mid: string } } }>({
      apiRoot: url,
      path: "/messages",
      method: "POST",
      token: "test-token",
      query: { chat_id: 7 },
      body: { text: "hi" },
    });
    expect(body.message.body.mid).toBe("mid-1");
    expect(observedContentType).toBe("application/json");
    expect(JSON.parse(observedBody)).toEqual({ text: "hi" });
  });

  it("throws UnauthorizedError on 401", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "verify.token", message: "Invalid access_token" }));
    });
    await expect(
      pollingHttpRequest({ apiRoot: url, path: "/updates", method: "GET", token: "t" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws RetryAfterError(retryAfterMs) on 429 with sec-int Retry-After", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "5" });
      res.end(JSON.stringify({ code: "rate_limit", message: "too many" }));
    });
    try {
      await pollingHttpRequest({ apiRoot: url, path: "/updates", method: "GET", token: "t" });
      throw new Error("expected RetryAfterError");
    } catch (err) {
      expect(err).toBeInstanceOf(RetryAfterError);
      expect((err as RetryAfterError).retryAfterMs).toBe(5_000);
      expect((err as RetryAfterError).status).toBe(429);
    }
  });

  it("falls back to ServerError(429) when 429 lacks a usable Retry-After", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "rate_limit", message: "too many" }));
    });
    try {
      await pollingHttpRequest({ apiRoot: url, path: "/updates", method: "GET", token: "t" });
      throw new Error("expected ServerError");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).status).toBe(429);
    }
  });

  it("throws ServerError on 5xx", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "service_unavailable", message: "down" }));
    });
    try {
      await pollingHttpRequest({ apiRoot: url, path: "/updates", method: "GET", token: "t" });
      throw new Error("expected ServerError");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).status).toBe(503);
    }
  });

  it("throws NetworkError when the server destroys the socket", async () => {
    const url = await startServer((req) => {
      req.socket.destroy();
    });
    await expect(
      pollingHttpRequest({ apiRoot: url, path: "/updates", method: "GET", token: "t" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws TimeoutError when the response exceeds requestTimeoutMs", async () => {
    const url = await startServer((_req, res) => {
      // Hold the connection open past the wrapper's timeout.
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      }, 5_000);
    });
    await expect(
      pollingHttpRequest({
        apiRoot: url,
        path: "/updates",
        method: "GET",
        token: "t",
        requestTimeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("re-throws caller-driven AbortError unchanged (not as NetworkError / TimeoutError)", async () => {
    const url = await startServer((_req, res) => {
      // Slow response so the caller signal can fire first.
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      }, 5_000);
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    try {
      await pollingHttpRequest({
        apiRoot: url,
        path: "/updates",
        method: "GET",
        token: "t",
        signal: ctrl.signal,
        requestTimeoutMs: 60_000,
      });
      throw new Error("expected AbortError");
    } catch (err) {
      expect(err).not.toBeInstanceOf(TimeoutError);
      expect(err).not.toBeInstanceOf(NetworkError);
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }
  });

  it("strips trailing slash from apiRoot when building URLs", async () => {
    let observedUrl: string | undefined;
    const url = await startServer((req, res) => {
      observedUrl = req.url ?? undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await pollingHttpRequest({
      apiRoot: `${url}//`,
      path: "/updates",
      method: "GET",
      token: "t",
    });
    expect(observedUrl).toBe("/updates");
  });
});
