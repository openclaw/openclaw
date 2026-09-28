/**
 * Test helper for reserving a loopback port for Browser control server tests.
 */
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { listenBrowserHttpServer } from "./http-listen.js";

/** Keep the bound socket until the real control-server app takes ownership. */
export async function reserveBrowserTestListener(listen: typeof listenBrowserHttpServer) {
  const pendingRequest: RequestListener = (_request, response) => {
    response.statusCode = 503;
    response.end();
  };
  while (true) {
    const server = await listen(pendingRequest, 0, "127.0.0.1");
    const close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    const address = server.address();
    if (!address || typeof address === "string") {
      await close();
      throw new Error("Browser test listener has no TCP address");
    }
    if (address.port === 65535) {
      await close();
      continue;
    }
    return {
      port: address.port,
      attach(app: RequestListener) {
        server.off("request", pendingRequest);
        server.on("request", app);
        return server;
      },
      close,
    };
  }
}

/** Returns an available 127.0.0.1 TCP port. */
export async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) {
      return port;
    }
  }
}
