import http from "node:http";
import type { AddressInfo } from "node:net";
// Tlon tests cover the sendSubscription bounded errorText read through a
// real loopback http.createServer, so the production urbitFetch path runs
// end-to-end without any vi.mock("./fetch.js") replacement. ClawSweeper's
// r1 P1 finding on PR #98083 said the previous helper-only proof would not
// catch a regression to response.text(); this test exercises the actual
// production `sendSubscription` branch with a hostile body that exceeds
// the 8 KiB cap, and asserts the bounded reader drops the surplus bytes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

// Mock channel-ops to avoid real channel operations; this test exercises
// only the sendSubscription bounded errorText read, not the channel open
// or poke paths.
vi.mock("./channel-ops.js", () => ({
  ensureUrbitChannelOpen: vi.fn().mockResolvedValue(undefined),
  pokeUrbitChannel: vi.fn().mockResolvedValue(undefined),
  scryUrbitPath: vi.fn().mockResolvedValue({}),
}));

type LoopbackContext = {
  server: http.Server;
  port: number;
  putRequestCount: { value: number };
  putBodyBytes: { value: number };
};

function startLoopbackServer(
  behavior: (res: http.ServerResponse, req: http.IncomingMessage) => void,
) {
  const ctx: LoopbackContext = {
    server: http.createServer(),
    port: 0,
    putRequestCount: { value: 0 },
    putBodyBytes: { value: 0 },
  };

  ctx.server.on("request", (req, res) => {
    if (req.method === "PUT" && req.url?.startsWith("/~/channel/")) {
      ctx.putRequestCount.value += 1;
      let bodyLen = 0;
      req.on("data", (chunk: Buffer) => {
        bodyLen += chunk.length;
      });
      req.on("end", () => {
        ctx.putBodyBytes.value = bodyLen;
        behavior(res, req);
      });
      return;
    }
    // Anything else (e.g. connect's GET) — return 204.
    res.statusCode = 204;
    res.end();
  });

  return new Promise<LoopbackContext>((resolve) => {
    ctx.server.listen(0, "127.0.0.1", () => {
      const addr = ctx.server.address() as AddressInfo;
      resolve({ ...ctx, port: addr.port });
    });
  });
}

const SSRF_POLICY_FOR_LOOPBACK = { allowPrivateNetwork: true } as const;

let oversizedCtx: LoopbackContext;
let verbatimCtx: LoopbackContext;

beforeAll(async () => {
  oversizedCtx = await startLoopbackServer((res) => {
    // Hostile 32 KiB body — exceeds the 8 KiB cap.
    const hostileBytes = Buffer.alloc(32 * 1024, 0x78);
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Length", String(hostileBytes.length));
    res.end(hostileBytes);
  });
  verbatimCtx = await startLoopbackServer((res) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    res.end("not authenticated");
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    oversizedCtx.server.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    verbatimCtx.server.close(() => resolve());
  });
});

beforeEach(() => {
  oversizedCtx.putRequestCount.value = 0;
  oversizedCtx.putBodyBytes.value = 0;
  verbatimCtx.putRequestCount.value = 0;
  verbatimCtx.putBodyBytes.value = 0;
});

describe("UrbitSSEClient.sendSubscription — loopback real-fetch proof", () => {
  it("absorbs the bounded-reader overflow and emits a status-only error for a 32 KiB hostile body (real http loopback)", async () => {
    const baseUrl = `http://127.0.0.1:${oversizedCtx.port}`;
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=loopback", {
      ssrfPolicy: SSRF_POLICY_FOR_LOOPBACK,
    });
    // Drive the connected-state subscribe path so sendSubscription runs.
    (client as unknown as { isConnected: boolean }).isConnected = true;

    let capturedError: unknown;
    await client.subscribe({
      app: "chat",
      path: "/dm/~zod",
      event: () => {},
      err: (e) => {
        capturedError = e;
      },
    });

    // The bounded reader threw on overflow; the production .catch(() => "")
    // swallowed the overflow and the error message is status-only.
    expect(capturedError).toBeInstanceOf(Error);
    const errMsg = (capturedError as Error).message;
    expect(errMsg.startsWith("Subscribe failed: 400")).toBe(true);
    // Crucially: the message does NOT contain the 32 KiB blob. If a regression
    // reverted sendSubscription to `response.text()`, the 32 KiB would have
    // landed in the error message (~32 KiB chars long).
    expect(errMsg.length).toBeLessThan(200);
    expect(errMsg).not.toContain("xxxxxxxxxx");
    // The loopback server saw exactly one PUT to /~/channel/<id> with the
    // subscription body. The 8 KiB cap is on the *response* read; the
    // request body is whatever JSON the production code sent (typically <100
    // bytes), and the bounded reader dropped everything past the 8 KiB cap
    // in the response without buffering the full 32 KiB into the error
    // message.
    expect(oversizedCtx.putRequestCount.value).toBe(1);
  });

  it("passes a short Urbit error verbatim through the bounded read (real http loopback)", async () => {
    const baseUrl = `http://127.0.0.1:${verbatimCtx.port}`;
    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=loopback", {
      ssrfPolicy: SSRF_POLICY_FOR_LOOPBACK,
    });
    (client as unknown as { isConnected: boolean }).isConnected = true;

    let capturedError: unknown;
    await client.subscribe({
      app: "chat",
      path: "/dm/~zod",
      event: () => {},
      err: (e) => {
        capturedError = e;
      },
    });

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe("Subscribe failed: 400 - not authenticated");
    expect(verbatimCtx.putRequestCount.value).toBe(1);
  });
});
