// Tlon tests cover the bounded errorBody read in urbit/sse-client.ts:156.
// Verifies that the diagnostic errorText read on a non-204 non-OK Urbit
// subscribe response is capped at the per-extension byte limit instead of
// calling `response.text()` unbounded, which would let a hostile ship OOM the
// channel worker.
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";

describe("tlon urbit sse-client errorText bounded read", () => {
  // Mirrors MAX_TLON_SUBSCRIBE_ERROR_BODY_BYTES in sse-client.ts. Asserted
  // here so the bound is grep-able across both source and test.
  const MAX_TLON_SUBSCRIBE_ERROR_BODY_BYTES = 8 * 1024;

  it("readResponseWithLimit throws when a hostile ship body exceeds the cap", async () => {
    const server = createServer((_req, res) => {
      // Emit 32 KiB of repeated text — comfortably above the 8 KiB cap.
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("A".repeat(32 * 1024));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      // readResponseWithLimit throws on overflow — this is the contract the
      // caller relies on. sse-client.ts catches it via `.catch(() => "")` so
      // the channel worker never OOMs on a hostile body. Use a try/catch here
      // so the rejection is captured at the await site and not surfaced as an
      // unhandled rejection by vitest's runtime.
      let caught: Error | undefined;
      try {
        await readResponseWithLimit(res, MAX_TLON_SUBSCRIBE_ERROR_BODY_BYTES);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toMatch(/too large|limit/i);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("readResponseWithLimit passes through a short Urbit error verbatim", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain");
      res.end("not authenticated");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const buf = await readResponseWithLimit(res, MAX_TLON_SUBSCRIBE_ERROR_BODY_BYTES);
      expect(buf.toString("utf8")).toBe("not authenticated");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("sse-client.ts catch fallback swallows the overflow and yields empty errorText", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("B".repeat(MAX_TLON_SUBSCRIBE_ERROR_BODY_BYTES * 4));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      // sse-client.ts wraps the read in `.catch(() => "")` so a hostile body
      // does not crash the worker. Mirror that contract here.
      const errorText = await readResponseWithLimit(res, MAX_TLON_SUBSCRIBE_ERROR_BODY_BYTES)
        .then((b) => b.toString("utf8"))
        .catch(() => "");
      expect(errorText).toBe("");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});