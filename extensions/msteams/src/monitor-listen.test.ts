import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";

/**
 * Tests for the Express server listen pattern used in monitorMSTeamsProvider.
 * Validates the fix for openclaw#22169 (EADDRINUSE restart loop):
 * - The listen promise must resolve ONLY after the port is bound
 * - EADDRINUSE on a busy port must reject (not silently fail)
 * - Shutdown must close all connections and release the port
 */

/** Mirrors the listen pattern from monitor.ts */
function startServer(port: number): Promise<http.Server> {
  return new Promise<http.Server>((resolveServer, rejectServer) => {
    const server = http.createServer();
    server.listen(port, () => {
      resolveServer(server);
    });
    server.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") {
        rejectServer(err);
      }
    });
  });
}

/** Mirrors the shutdown pattern from monitor.ts */
function shutdownServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Find a free port by binding to 0 and releasing. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("monitor listen pattern (openclaw#22169)", () => {
  it("resolves only after the port is bound", async () => {
    const port = await getFreePort();
    const server = await startServer(port);

    // If we reach here, the server is listening (promise resolved after bind).
    // Verify by checking the address is assigned.
    const addr = server.address() as net.AddressInfo;
    expect(addr).not.toBeNull();
    expect(addr.port).toBe(port);

    await shutdownServer(server);
  });

  it("rejects with EADDRINUSE when the port is already taken", async () => {
    const port = await getFreePort();
    const first = await startServer(port);

    try {
      // Second bind on the same port must reject, not silently fail.
      await expect(startServer(port)).rejects.toThrow();
    } finally {
      await shutdownServer(first);
    }
  });

  it("releases the port after shutdown so it can be rebound", async () => {
    const port = await getFreePort();
    const first = await startServer(port);
    await shutdownServer(first);

    // Port should be free again.
    const second = await startServer(port);
    const addr = second.address() as net.AddressInfo;
    expect(addr.port).toBe(port);
    await shutdownServer(second);
  });

  it("shutdown closes active connections", async () => {
    const port = await getFreePort();
    const server = await startServer(port);

    // Open a keep-alive connection.
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve) => socket.on("connect", resolve));

    // Track when the socket is closed.
    const closed = new Promise<void>((resolve) => socket.on("close", resolve));

    // Shutdown should force-close it (closeAllConnections).
    await shutdownServer(server);
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});
