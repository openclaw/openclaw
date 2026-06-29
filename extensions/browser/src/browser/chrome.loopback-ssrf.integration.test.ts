// Browser tests cover chrome.loopback ssrf.integration plugin behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readChromeVersion } from "./chrome.diagnostics.js";
import { getChromeWebSocketUrl, isChromeReachable } from "./chrome.js";

type RunningServer = {
  server: Server;
  baseUrl: string;
};

const runningServers: Server[] = [];

async function startLoopbackCdpServer(): Promise<RunningServer> {
  const server = createServer((req, res) => {
    if (req.url !== "/json/version") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const address = server.address() as AddressInfo;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        Browser: "Chrome/999.0.0.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/TEST`,
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

describe("chrome loopback SSRF integration", () => {
  it("keeps loopback CDP HTTP reachability working under strict default SSRF policy", async () => {
    const { baseUrl } = await startLoopbackCdpServer();

    await expect(isChromeReachable(baseUrl, 500, {})).resolves.toBe(true);
  });

  it("returns the loopback websocket URL under strict default SSRF policy", async () => {
    const { baseUrl } = await startLoopbackCdpServer();

    await expect(getChromeWebSocketUrl(baseUrl, 500, {})).resolves.toMatch(
      /\/devtools\/browser\/TEST$/,
    );
  });

  it("readChromeVersion caps oversized /json/version body at 16 MiB via real wire", async () => {
    // Regression: a hostile or broken CDP endpoint can return an unbounded
    // body on /json/version. readChromeVersion must reject before allocating
    // the full body. Without the cap, an oversized body could push the
    // runtime into OOM territory.
    const MAX = 16 * 1024 * 1024;
    const TOTAL = 18 * 1024 * 1024;
    const server = createServer((req, res) => {
      if (req.url !== "/json/version") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "application/json");
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
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    runningServers.push(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(
      readChromeVersion(baseUrl, 5000, { allowPrivateNetwork: true }),
    ).rejects.toThrow(/CDP \/json\/version: body exceeds 16777216 bytes/i);

    console.log(
      `[browser chrome.diagnostics bounded-read proof] oversized path: cap=${MAX} bytes; oversize=${TOTAL}`,
    );
  });
});
