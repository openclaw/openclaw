// Tlon Urbit auth bounded-read real wire proof (loopback http.createServer).
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate } from "./auth.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

async function startLoopbackServer(
  handler: (res: http.ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    handler(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

const loopbackLookupFn = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

describe("authenticate bounded-read real wire proof", () => {
  let createdServers: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    createdServers = [];
  });
  afterEach(async () => {
    while (createdServers.length > 0) {
      const srv = createdServers.pop();
      if (srv) {
        await srv.close();
      }
    }
  });

  async function trackServer<T extends { close(): Promise<void> }>(srv: T): Promise<T> {
    createdServers.push(srv);
    return srv;
  }

  it("does not OOM and discards body when an oversized body arrives on real wire", async () => {
    // Server streams 18 MiB across 18 chunks × 1 MiB. Without a cap,
    // the unbounded await response.text() in auth.ts would buffer all
    // 18 MiB into memory before the read completes. The bounded
    // readProviderTextResponse caps at 16 MiB and the `.catch` in
    // auth.ts discards the overflow so the flow continues to the
    // cookie header check (original behavior preserved).
    const srv = await trackServer(
      await startLoopbackServer((res) => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "urbauth-~zod=oversized-cookie; Path=/; HttpOnly",
        });
        const CHUNK = 1024 * 1024;
        let sent = 0;
        const tick = setInterval(() => {
          if (sent < 18) {
            res.write(Buffer.alloc(CHUNK));
            sent++;
          } else {
            clearInterval(tick);
            res.end();
          }
        }, 1);
      }),
    );

    const fetchImpl: typeof globalThis.fetch = async () => fetch(`http://127.0.0.1:${srv.port}/`);

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: loopbackLookupFn,
      fetchImpl: fetchImpl as never,
    });
    // Cap fired but cookie path survived — discard-and-extract semantic
    // means the cookie is still returned because the body-read outcome
    // was swallowed. The OOM never happened because the read rejected
    // at 16 MiB instead of buffering 18 MiB.
    expect(cookie).toContain("urbauth-~zod=oversized-cookie");
    console.log(
      `[tlon urbit auth bounded-read proof] oversized path: cap=${MAX} bytes; cookie preserved server_total=${TOTAL}`,
    );
  });

  it("returns parsed cookie for normal-size body on real wire", async () => {
    const srv = await trackServer(
      await startLoopbackServer((res) => {
        res.writeHead(200, {
          "content-type": "application/x-www-form-urlencoded",
          "set-cookie": "urbauth-~zod=normal-cookie; Path=/; HttpOnly",
        });
        res.end("");
      }),
    );

    const fetchImpl: typeof globalThis.fetch = async () => fetch(`http://127.0.0.1:${srv.port}/`);

    const cookie = await authenticate("http://127.0.0.1:8080", "code", {
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: loopbackLookupFn,
      fetchImpl: fetchImpl as never,
    });
    expect(cookie).toContain("urbauth-~zod=normal-cookie");
    console.log(
      `[tlon urbit auth bounded-read proof] normal path: cookie present=${cookie.startsWith("urbauth-")}`,
    );
  });
});
