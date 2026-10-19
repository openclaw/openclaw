import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./bridge-server.js";
import { resolveBrowserConfig } from "./config.js";
import { isBrowserRuntimeRunning } from "./server-context.lifecycle.js";

const tokenAuth = { authToken: "secret-token" };
const tokenHeaders = { Authorization: "Bearer secret-token" };

function buildResolvedConfig() {
  return {
    ...resolveBrowserConfig({
      evaluateEnabled: false,
      attachOnly: true,
      defaultProfile: "openclaw",
      profiles: { openclaw: { cdpPort: 1 } },
    }),
    controlPort: 0,
  };
}

describe("startBrowserBridgeServer auth", () => {
  const servers: Awaited<ReturnType<typeof startBrowserBridgeServer>>[] = [];
  async function startBridge(
    options: Omit<Parameters<typeof startBrowserBridgeServer>[0], "resolved"> = {},
  ) {
    const bridge = await startBrowserBridgeServer({ resolved: buildResolvedConfig(), ...options });
    servers.push(bridge);
    return bridge;
  }

  async function expectAuthFlow(
    authConfig: { authToken?: string; authPassword?: string },
    headers: Record<string, string>,
    host?: string,
  ) {
    const bridge = await startBridge({ ...authConfig, host });
    const url = `${bridge.baseUrl}/?profile=__auth_probe_missing__`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers })).status).toBe(404);
  }

  afterEach(async () => {
    for (const bridge of servers.splice(0).toReversed()) {
      await stopBrowserBridgeServer(bridge.server);
    }
  });

  it.each(["127.0.0.1", "::1"])(
    "authenticates through the returned bridge URL on %s",
    async (host) => {
      await expectAuthFlow(tokenAuth, tokenHeaders, host);
    },
  );

  it("accepts x-openclaw-password when authPassword is set", async () => {
    await expectAuthFlow(
      { authPassword: "secret-password" },
      { "x-openclaw-password": "secret-password" },
    );
  });

  it("requires auth params", async () => {
    await expect(startBridge()).rejects.toThrow(/requires auth/i);
  });

  it("rejects startup when the bridge port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("expected blocker TCP address");
    }

    try {
      await expect(
        startBridge({
          ...tokenAuth,
          host: "127.0.0.1",
          port: address.port,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });

  it("closes ingress but retains exact bridge cleanup state for retry", async () => {
    const bridge = await startBridge(tokenAuth);
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("relay cleanup failed"))
      .mockResolvedValue(undefined);
    const relay = { port: 18_799, token: "relay-token", bridge: {}, close };
    bridge.state.extensionRelays = new Map([["openclaw", relay as never]]);
    expect(getBridgeAuthForPort(bridge.port)).toEqual({ token: "secret-token" });

    const firstStop = stopBrowserBridgeServer(bridge.server);
    const concurrentStop = stopBrowserBridgeServer(bridge.server);
    expect(concurrentStop).toBe(firstStop);
    await expect(firstStop).rejects.toThrow("relay cleanup failed");
    await expect(concurrentStop).rejects.toThrow("relay cleanup failed");
    expect(bridge.server.listening).toBe(false);
    expect(getBridgeAuthForPort(bridge.port)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();

    await expect(stopBrowserBridgeServer(bridge.server)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("invalidates an active request before waiting for HTTP close", async () => {
    const attachStarted = Promise.withResolvers<void>();
    const releaseAttach = Promise.withResolvers<void>();
    const bridge = await startBridge({
      ...tokenAuth,
      onEnsureAttachTarget: async () => {
        attachStarted.resolve();
        await releaseAttach.promise;
      },
    });

    const startRequest = fetch(`${bridge.baseUrl}/start`, {
      method: "POST",
      headers: tokenHeaders,
    });
    await attachStarted.promise;

    const stopping = stopBrowserBridgeServer(bridge.server);
    try {
      expect(stopBrowserBridgeServer(bridge.server)).toBe(stopping);
      expect(bridge.server.listening).toBe(false);
      expect(isBrowserRuntimeRunning(bridge.state)).toBe(false);
    } finally {
      releaseAttach.resolve();
    }

    await Promise.all([stopping, startRequest.catch(() => undefined)]);
  });

  it("serves noVNC bootstrap html without leaking password in Location header", async () => {
    let resolveCalls = 0;
    const bridge = await startBridge({
      ...tokenAuth,
      resolveSandboxNoVncToken: (token) => {
        resolveCalls += 1;
        if (token !== "valid-token") {
          return null;
        }
        return { noVncPort: 45678, password: "Abc123xy" }; // pragma: allowlist secret
      },
    });

    const unauth = await fetch(`${bridge.baseUrl}/sandbox/novnc?token=valid-token`);
    expect(unauth.status).toBe(401);
    expect(resolveCalls).toBe(0);

    const res = await fetch(`${bridge.baseUrl}/sandbox/novnc?token=valid-token`, {
      headers: tokenHeaders,
    });
    expect(res.status).toBe(200);
    expect(resolveCalls).toBe(1);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const body = await res.text();
    expect(body).toContain("window.location.replace");
    expect(body).toContain(
      "http://127.0.0.1:45678/vnc.html#autoconnect=1&resize=remote&password=Abc123xy",
    );
    expect(body).not.toContain("?password=");
  });
});
