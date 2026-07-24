// Real-transport proof: CDP status-only probes must cancel unread bodies.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchCdpChecked, fetchOk } from "./cdp.helpers.js";

const CLIENT_CLOSE_TIMEOUT_MS = 1_000;

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function waitForClientClose(clientClosed: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      clientClosed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for the CDP client socket to close")),
          CLIENT_CLOSE_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createStalledResponseServer(status: number): {
  server: Server;
  clientClosed: Promise<void>;
} {
  let resolveClientClosed: (() => void) | undefined;
  const clientClosed = new Promise<void>((resolve) => {
    resolveClientClosed = resolve;
  });
  const server = createServer((request, response) => {
    request.socket.once("close", () => resolveClientClosed?.());
    response.writeHead(status, { "Content-Type": "application/json" });
    response.write(
      status === 200
        ? '{"Browser":"Chrome","webSocketDebuggerUrl":"ws://127.0.0.1/devtools'
        : '{"error":"unavailable"',
    );
  });
  return { server, clientClosed };
}

describe("cdp helpers transport body cleanup", () => {
  it("fetchOk cancels unread bodies and closes the request socket", async () => {
    const { server, clientClosed } = createStalledResponseServer(200);

    const baseUrl = await listen(server);
    try {
      await expect(
        fetchOk(`${baseUrl}/json/version`, 2_000, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).resolves.toBeUndefined();
      await expect(waitForClientClose(clientClosed)).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("fetchCdpChecked cancels unread bodies on non-OK status before throwing", async () => {
    const { server, clientClosed } = createStalledResponseServer(503);

    const baseUrl = await listen(server);
    try {
      await expect(
        fetchCdpChecked(`${baseUrl}/json/version`, 2_000, undefined, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).rejects.toThrow("HTTP 503");
      await expect(waitForClientClose(clientClosed)).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });
});
