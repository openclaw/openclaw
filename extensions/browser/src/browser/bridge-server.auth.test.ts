// Browser tests cover bridge server.auth plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SANDBOX_BROWSER_REFRESH_HEADER,
  SANDBOX_BROWSER_REFRESH_VALUE,
} from "./bridge-auth-registry.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./bridge-server.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type { ResolvedBrowserConfig } from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";

function buildResolvedConfig(): ResolvedBrowserConfig {
  return {
    enabled: true,
    evaluateEnabled: false,
    controlPort: 0,
    cdpPortRangeStart: 18800,
    cdpPortRangeEnd: 18899,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    localLaunchTimeoutMs: 15_000,
    localCdpReadyTimeoutMs: 8_000,
    extraArgs: [],
    color: DEFAULT_OPENCLAW_BROWSER_COLOR,
    executablePath: undefined,
    headless: true,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
    profiles: {
      [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
        cdpPort: 1,
        color: DEFAULT_OPENCLAW_BROWSER_COLOR,
      },
    },
  } as unknown as ResolvedBrowserConfig;
}

describe("startBrowserBridgeServer auth", () => {
  const servers: Array<{ stop: () => Promise<void> }> = [];

  async function expectAuthFlow(
    authConfig: { authToken?: string; authPassword?: string },
    headers: Record<string, string>,
  ) {
    const bridge = await startBrowserBridgeServer({
      resolved: buildResolvedConfig(),
      ...authConfig,
      skipRouteRegistrationForTest: true,
    });
    servers.push({ stop: () => stopBrowserBridgeServer(bridge.server) });

    const unauth = await fetch(`${bridge.baseUrl}/`);
    expect(unauth.status).toBe(401);

    const authed = await fetch(`${bridge.baseUrl}/`, { headers });
    expect(authed.status).toBe(200);
  }

  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      if (s) {
        await s.stop();
      }
    }
  });

  it("rejects unauthenticated requests when authToken is set", async () => {
    await expectAuthFlow({ authToken: "secret-token" }, { Authorization: "Bearer secret-token" });
  });

  it("accepts x-openclaw-password when authPassword is set", async () => {
    await expectAuthFlow(
      { authPassword: "secret-password" },
      { "x-openclaw-password": "secret-password" },
    );
  });

  it("requires auth params", async () => {
    await expect(
      startBrowserBridgeServer({
        resolved: buildResolvedConfig(),
      }),
    ).rejects.toThrow(/requires auth/i);
  });

  it("returns 503 while the sandbox runtime is being replaced", async () => {
    const bridge = await startBrowserBridgeServer({
      resolved: buildResolvedConfig(),
      authToken: "secret-token",
      skipRouteRegistrationForTest: true,
      tryAcquireActivityLease: () => null,
    });
    servers.push({ stop: () => stopBrowserBridgeServer(bridge.server) });

    const unauth = await fetch(`${bridge.baseUrl}/`);
    expect(unauth.status).toBe(401);
    const blocked = await fetch(`${bridge.baseUrl}/`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get(SANDBOX_BROWSER_REFRESH_HEADER)).toBe(SANDBOX_BROWSER_REFRESH_VALUE);
    expect(blocked.headers.get("retry-after")).toBe("1");
  });

  it("retries an authenticated POST only after the refresh gate rejects it", async () => {
    const release = vi.fn();
    let refreshing = true;
    const tryAcquireActivityLease = vi.fn(() => {
      if (refreshing) {
        refreshing = false;
        return null;
      }
      return { release };
    });
    const bridge = await startBrowserBridgeServer({
      resolved: buildResolvedConfig(),
      authToken: "secret-token",
      skipRouteRegistrationForTest: true,
      tryAcquireActivityLease,
    });
    servers.push({ stop: () => stopBrowserBridgeServer(bridge.server) });

    await expect(
      fetchBrowserJson<{ ok: boolean }>(`${bridge.baseUrl}/`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "probe" }),
        timeoutMs: 2_500,
      }),
    ).resolves.toEqual({ ok: true });
    expect(tryAcquireActivityLease).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases sandbox activity after an authenticated response", async () => {
    const release = vi.fn();
    const bridge = await startBrowserBridgeServer({
      resolved: buildResolvedConfig(),
      authToken: "secret-token",
      skipRouteRegistrationForTest: true,
      tryAcquireActivityLease: () => ({ release }),
    });
    servers.push({ stop: () => stopBrowserBridgeServer(bridge.server) });

    const response = await fetch(`${bridge.baseUrl}/`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(release).toHaveBeenCalledOnce();
  });

  it("serves noVNC bootstrap html without leaking password in Location header", async () => {
    let resolveCalls = 0;
    const bridge = await startBrowserBridgeServer({
      resolved: buildResolvedConfig(),
      authToken: "secret-token",
      skipRouteRegistrationForTest: true,
      resolveSandboxNoVncToken: (token) => {
        resolveCalls += 1;
        if (token !== "valid-token") {
          return null;
        }
        return { noVncPort: 45678, password: "Abc123xy" }; // pragma: allowlist secret
      },
    });
    servers.push({ stop: () => stopBrowserBridgeServer(bridge.server) });

    const unauth = await fetch(`${bridge.baseUrl}/sandbox/novnc?token=valid-token`);
    expect(unauth.status).toBe(401);
    expect(resolveCalls).toBe(0);

    const res = await fetch(`${bridge.baseUrl}/sandbox/novnc?token=valid-token`, {
      headers: { Authorization: "Bearer secret-token" },
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
