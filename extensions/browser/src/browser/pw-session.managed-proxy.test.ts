// Browser tests cover Playwright managed-proxy bypass lifecycle behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(
    () => undefined,
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime-internal")>();
  return {
    ...actual,
    registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
  };
});

import { pwAi } from "./pw-ai.js";

const { closePlaywrightBrowserConnection, listPagesViaPlaywright } = pwAi;

type ManagedLease = {
  url: string;
  release: ReturnType<typeof vi.fn>;
};

type DiscoveryServer = {
  baseUrl: string;
  bareWsUrl: string;
  requests: string[];
  versionUrl: string;
  wsUrl: string;
};

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const runningServers: Server[] = [];

async function startDiscoveryServer(
  options: {
    servedPaths?: readonly string[];
    includeWebSocketUrl?: boolean;
  } = {},
): Promise<DiscoveryServer> {
  const servedPaths = options.servedPaths ?? ["/json/version"];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const requestPath = req.url ?? "";
    requests.push(requestPath);
    if (!servedPaths.includes(requestPath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const address = server.address() as AddressInfo;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "Chrome/Mock",
        ...(options.includeWebSocketUrl === false
          ? {}
          : {
              webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/discovered`,
            }),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  runningServers.push(server);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    bareWsUrl: `ws://127.0.0.1:${port}`,
    requests,
    versionUrl: `${baseUrl}/json/version`,
    wsUrl: `ws://127.0.0.1:${port}/devtools/browser/discovered`,
  };
}

function captureManagedLeases(): ManagedLease[] {
  const leases: ManagedLease[] = [];
  registerManagedProxyBrowserCdpBypassMock.mockImplementation((url) => {
    const release = vi.fn();
    leases.push({ url, release });
    return release;
  });
  return leases;
}

function createDeferredBrowser(): {
  promise: Promise<import("playwright-core").Browser>;
  resolve: (browser: import("playwright-core").Browser) => void;
} {
  let resolve: ((browser: import("playwright-core").Browser) => void) | undefined;
  const promise = new Promise<import("playwright-core").Browser>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) {
    throw new Error("Expected deferred callback to be initialized");
  }
  return { promise, resolve };
}

function makeBrowser(): import("playwright-core").Browser {
  const context = {
    pages: () => [],
    on: vi.fn(),
  } as unknown as import("playwright-core").BrowserContext;
  return {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as import("playwright-core").Browser;
}

function releaseCounts(leases: ManagedLease[]): number[] {
  return leases.map((lease) => lease.release.mock.calls.length);
}

afterEach(async () => {
  await closePlaywrightBrowserConnection().catch(() => {});
  connectOverCdpSpy.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Playwright managed-proxy bypass", () => {
  it.each([
    {
      name: "canonical",
      servedPaths: ["/json/version"],
      expectedRequests: ["/json/version"],
    },
    {
      name: "Playwright-compatible trailing-slash",
      servedPaths: ["/json/version/"],
      expectedRequests: ["/json/version", "/json/version/"],
    },
  ])("owns every actual URL for $name discovery", async ({ servedPaths, expectedRequests }) => {
    const server = await startDiscoveryServer({ servedPaths });
    const leases = captureManagedLeases();
    const handshake = createDeferredBrowser();
    connectOverCdpSpy.mockImplementationOnce(async () => await handshake.promise);

    const listing = listPagesViaPlaywright({ cdpUrl: server.baseUrl });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledOnce());

    const expectedHttpUrls = expectedRequests.map((path) => `${server.baseUrl}${path}`);
    expect(server.requests).toEqual(expectedRequests);
    expect(connectOverCdpSpy).toHaveBeenCalledWith(server.wsUrl, {
      timeout: 5000,
      headers: {},
    });
    expect(leases.map((lease) => lease.url)).toEqual([...expectedHttpUrls, server.wsUrl]);
    expect(releaseCounts(leases)).toEqual([...expectedHttpUrls.map(() => 1), 0]);

    handshake.resolve(makeBrowser());
    await expect(listing).resolves.toEqual([]);
    expect(releaseCounts(leases)).toEqual(leases.map(() => 1));
  });

  it("never hands an unresolved HTTP endpoint to Playwright", async () => {
    const server = await startDiscoveryServer({
      servedPaths: ["/json/version", "/json/version/"],
      includeWebSocketUrl: false,
    });
    const leases = captureManagedLeases();

    await expect(listPagesViaPlaywright({ cdpUrl: server.baseUrl })).rejects.toThrow(
      "CDP HTTP endpoint did not expose a usable WebSocket URL.",
    );

    expect(connectOverCdpSpy).not.toHaveBeenCalled();
    expect(server.requests).toEqual([
      "/json/version",
      "/json/version/",
      "/json/version",
      "/json/version/",
      "/json/version",
      "/json/version/",
    ]);
    expect(leases.map((lease) => lease.url)).toEqual(
      server.requests.map((path) => `${server.baseUrl}${path}`),
    );
    expect(releaseCounts(leases)).toEqual(leases.map(() => 1));
  });

  it("releases discovery and WebSocket leases after a failed handshake", async () => {
    const server = await startDiscoveryServer();
    const leases = captureManagedLeases();
    connectOverCdpSpy.mockRejectedValueOnce(new Error("rate limit"));

    await expect(listPagesViaPlaywright({ cdpUrl: server.baseUrl })).rejects.toThrow("rate limit");

    expect(leases.map((lease) => lease.url)).toEqual([server.versionUrl, server.wsUrl]);
    expect(releaseCounts(leases)).toEqual([1, 1]);
  });

  it("uses and releases exact discovery and WebSocket leases for each retry", async () => {
    const server = await startDiscoveryServer();
    const leases = captureManagedLeases();
    const handshake = createDeferredBrowser();
    connectOverCdpSpy
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockImplementationOnce(async () => await handshake.promise);

    const listing = listPagesViaPlaywright({ cdpUrl: server.baseUrl });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledTimes(2));

    expect(server.requests).toEqual(["/json/version", "/json/version"]);
    expect(leases.map((lease) => lease.url)).toEqual([
      server.versionUrl,
      server.wsUrl,
      server.versionUrl,
      server.wsUrl,
    ]);
    expect(releaseCounts(leases)).toEqual([1, 1, 1, 0]);

    handshake.resolve(makeBrowser());
    await expect(listing).resolves.toEqual([]);
    expect(releaseCounts(leases)).toEqual([1, 1, 1, 1]);
  });

  it("releases discovery before activating the bare WebSocket fallback", async () => {
    const server = await startDiscoveryServer();
    const leases = captureManagedLeases();
    const handshake = createDeferredBrowser();
    connectOverCdpSpy
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockImplementationOnce(async () => await handshake.promise);

    const listing = listPagesViaPlaywright({ cdpUrl: server.bareWsUrl });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledTimes(2));

    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(1, server.wsUrl, expect.any(Object));
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(2, server.bareWsUrl, expect.any(Object));
    expect(leases.map((lease) => lease.url)).toEqual([
      server.versionUrl,
      server.wsUrl,
      server.bareWsUrl,
    ]);
    expect(releaseCounts(leases)).toEqual([1, 1, 0]);

    handshake.resolve(makeBrowser());
    await expect(listing).resolves.toEqual([]);
    expect(releaseCounts(leases)).toEqual([1, 1, 1]);
  });

  it("releases the exact WebSocket lease after a superseded handshake settles", async () => {
    const server = await startDiscoveryServer();
    const leases = captureManagedLeases();
    const handshake = createDeferredBrowser();
    connectOverCdpSpy.mockImplementationOnce(async () => await handshake.promise);

    const listing = listPagesViaPlaywright({ cdpUrl: server.baseUrl });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledOnce());
    const closing = closePlaywrightBrowserConnection({ cdpUrl: server.baseUrl });
    expect(releaseCounts(leases)).toEqual([1, 0]);

    handshake.resolve(makeBrowser());
    await expect(listing).rejects.toThrow("superseded");
    await expect(closing).resolves.toBeUndefined();
    expect(releaseCounts(leases)).toEqual([1, 1]);
  });
});
