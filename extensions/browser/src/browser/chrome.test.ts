import { EventEmitter } from "node:events";
import http from "node:http";
import { createServer as createTcpServer } from "node:net";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { CHROME_STOP_PROBE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { withMockChromeCdpServer } from "./chrome.cdp.test-support.js";
import { diagnoseChromeCdp, formatChromeCdpDiagnostic } from "./chrome.diagnostics.js";
import {
  getChromeWebSocketEndpoint,
  isChromeCdpOwnedByPid,
  isChromeReachable,
  ManagedChromeCleanupError,
  stopOpenClawChrome,
} from "./chrome.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

type StopChromeTarget = Parameters<typeof stopOpenClawChrome>[0];
const loopbackOnly = { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] };

function mockVersionEndpoint(wsUrl: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ webSocketDebuggerUrl: wsUrl })),
  );
}
async function getChromeWebSocketUrl(
  ...args: Parameters<typeof getChromeWebSocketEndpoint>
): Promise<string | null> {
  return (await getChromeWebSocketEndpoint(...args))?.url ?? null;
}

function replyWithBrowserVersion(method: string, id: number) {
  expect(method).toBe("Browser.getVersion");
  expect(id).toBe(1);
  return { product: "Browserless/Mock", userAgent: "Browserless Mock UA" };
}

function replyToShutdown(proc: ReturnType<typeof makeChromeTestProc>, close?: () => void) {
  return (method: string) => {
    if (method === "SystemInfo.getProcessInfo") {
      return { processInfo: [{ type: "browser", id: proc.pid }] };
    }
    expect(method).toBe("Browser.close");
    close?.();
    return {};
  };
}

async function stopChromeWithProc(proc: ReturnType<typeof makeChromeTestProc>, timeoutMs: number) {
  await stopOpenClawChrome(
    {
      pid: proc.pid,
      proc,
      cdpPort: 12345,
    } as unknown as StopChromeTarget,
    timeoutMs,
  );
}

function makeChromeTestProc(
  overrides?: Partial<{
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    exitOnSignal: NodeJS.Signals | false;
  }>,
) {
  const proc = Object.assign(new EventEmitter(), {
    pid: process.pid,
    killed: overrides?.killed ?? false,
    exitCode: overrides?.exitCode ?? null,
    signalCode: overrides?.signalCode ?? null,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.killed = true;
      if ((overrides?.exitOnSignal ?? "SIGTERM") === signal) {
        proc.signalCode = signal;
        proc.emit("exit", null, signal);
      }
      return true;
    }),
  });
  return proc;
}

describe("browser chrome helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["missing_websocket_debugger_url", () => jsonResponse({ Browser: "Chrome/Mock" })],
    ["invalid_json", () => new Response("{", { headers: { "content-type": "application/json" } })],
  ] as const)(
    "preserves %s diagnostics for bounded /json/version reads",
    async (code, response) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response()),
      );
      await expect(diagnoseChromeCdp("http://127.0.0.1:12345", 50, 50)).resolves.toMatchObject({
        ok: false,
        code,
        cdpUrl: "http://127.0.0.1:12345",
      });
    },
  );

  it("allows loopback CDP probes while still blocking non-loopback private targets in strict SSRF mode", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }))
      .mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      isChromeReachable("http://127.0.0.1:12345", 50, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBe(true);
    await expect(
      isChromeReachable("http://169.254.169.254:12345", 50, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBe(false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-host websocket pivots returned by /json/version in strict SSRF mode", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/pivot",
      version: { webSocketDebuggerUrl: "ws://169.254.169.254:9222/devtools/browser/pivot" },
      run: async (baseUrl) => {
        await expect(getChromeWebSocketUrl(baseUrl, 1000, loopbackOnly)).rejects.toBeInstanceOf(
          BrowserCdpEndpointBlockedError,
        );
      },
    });
  });

  it("keeps authenticated trailing-slash discovery inside the guarded fetch path", async () => {
    const authorization = `Basic ${Buffer.from("browser-user:browser-password").toString("base64")}`;
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/authenticated",
      versionPath: "/json/version/",
      authorization,
      run: async (baseUrl, requests) => {
        const credentialedUrl = baseUrl.replace("http://", "http://browser-user:browser-password@");
        const expectedRequests = [
          { authorization, url: "/json/version" },
          { authorization, url: "/json/version/" },
        ];
        await expect(isChromeReachable(credentialedUrl, 1000, loopbackOnly)).resolves.toBe(true);
        expect(requests).toEqual(expectedRequests);
        requests.length = 0;
        await expect(getChromeWebSocketUrl(credentialedUrl, 1000, loopbackOnly)).resolves.toBe(
          `${credentialedUrl.replace("http:", "ws:")}/devtools/browser/authenticated`,
        );
        expect(requests).toEqual(expectedRequests);
      },
    });
  });

  it("formats diagnostics with redacted CDP credentials", () => {
    const formatted = formatChromeCdpDiagnostic({
      ok: false,
      code: "websocket_handshake_failed",
      cdpUrl: "https://user:pass@browserless.example.com?token=supersecret123",
      wsUrl: "wss://user:pass@browserless.example.com/devtools/browser/1?token=supersecret123",
      message: "connect ECONNREFUSED browserless.example.com",
      elapsedMs: 12,
    });

    expect(formatted).toContain("websocket_handshake_failed");
    expect(formatted).toContain("https://browserless.example.com/?token=***");
    expect(formatted).toContain("wss://browserless.example.com/devtools/browser/1?token=***");
    expect(formatted).not.toContain("user");
    expect(formatted).not.toContain("pass");
    expect(formatted).not.toContain("supersecret123");
  });

  it.each(["http://127.0.0.1", "ws://127.0.0.1", "http://localhost"])(
    "reports a refused %s CDP connection",
    async (origin) => {
      const closed = createTcpServer(() => {});
      const port = await listenOnLoopback(closed);
      await new Promise<void>((resolve) => {
        closed.close(() => resolve());
      });

      await expect(diagnoseChromeCdp(`${origin}:${port}`, 500, 500)).resolves.toMatchObject({
        ok: false,
        connectionRefused: true,
      });
    },
  );

  it("surfaces Windows listener checks from a real empty-reply CDP probe", async () => {
    // A broken portproxy accepts the WSL-side socket and closes it without an
    // HTTP body. The host checks must survive the full probe/format path.
    const portproxy = createTcpServer((socket) => socket.destroy());
    const port = await listenOnLoopback(portproxy);
    try {
      const diagnostic = await diagnoseChromeCdp(`http://127.0.0.1:${port}`, 500, 50);
      expect(diagnostic).toMatchObject({ ok: false, code: "http_unreachable" });
      const formatted = formatChromeCdpDiagnostic(diagnostic);
      expect(formatted).toContain("netstat -ano");
      expect(formatted).toContain("netsh interface portproxy show all");
      expect(formatted).toContain("svchost/iphlpsvc owns");
      expect(formatted).toContain("127.0.0.1:9222 -> 127.0.0.1:9222");
      expect(formatted).toContain("falls back to [::1] only when the IPv4 bind fails");
      expect(formatted).toContain("v4tov6");
      expect(formatted).not.toContain("Chrome 136");
    } finally {
      await new Promise<void>((resolve) => {
        portproxy.close(() => resolve());
      });
    }
  });

  it("resolves and probes direct WebSocket endpoints without HTTP before and after shutdown", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);
    let directUrl = "";
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/direct",
      run: async (baseUrl) => {
        directUrl = `${baseUrl.replace("http:", "ws:")}/devtools/browser/direct`;
        await expect(getChromeWebSocketUrl(directUrl, 50)).resolves.toBe(directUrl);
        await expect(isChromeReachable(directUrl, 500)).resolves.toBe(true);
      },
    });
    await expect(isChromeReachable(directUrl, 50)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to HTTP /json/version discovery for a bare ws:// CDP URL (issue #68027)", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/DISCOVERED",
      run: async (baseUrl) => {
        const url = new URL(baseUrl);
        const wsOnlyBase = `ws://${url.host}`;
        await expect(isChromeReachable(wsOnlyBase, 300)).resolves.toBe(true);
        await expect(getChromeWebSocketUrl(wsOnlyBase, 300)).resolves.toBe(
          `ws://${url.host}/devtools/browser/DISCOVERED`,
        );
      },
    });
  });

  it("falls back to the bare WebSocket root when discovered Browserless endpoint rejects readiness", async () => {
    await withMockChromeCdpServer({
      wsPath: "/",
      advertisedPath: "/e/bad",
      browser: "Browserless/Mock",
      reply: replyWithBrowserVersion,
      run: async (baseUrl) => {
        const wsOnlyBase = `${baseUrl.replace("http:", "ws:")}?token=abc`;
        await expect(diagnoseChromeCdp(wsOnlyBase, 300, 400)).resolves.toMatchObject({
          ok: true,
          wsUrl: wsOnlyBase,
          browser: "Browserless/Mock",
        });
      },
    });
  });

  it("reports unreachable when a bare ws:// CDP URL points at a server with no /json/version and refuses WS", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchSpy);
    // Port 19998 is not listening; the WS fallback probe will also fail.
    await expect(isChromeReachable("ws://127.0.0.1:19998", 50)).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("falls back to a direct WS readiness check when /json/version has no debugger URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await withMockChromeCdpServer({
      wsPath: "/",
      reply: replyWithBrowserVersion,
      run: async (baseUrl) => {
        const wsUrl = baseUrl.replace("http:", "ws:");
        await expect(diagnoseChromeCdp(wsUrl, 500, 500)).resolves.toMatchObject({
          ok: true,
          wsUrl,
          browser: "Browserless/Mock",
        });
      },
    });
  });

  it("verifies the exact managed browser pid through CDP SystemInfo", async () => {
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/process-owner",
      reply: (method) => {
        expect(method).toBe("SystemInfo.getProcessInfo");
        return { processInfo: [{ type: "browser", id: 44001 }] };
      },
      run: async (baseUrl) => {
        await expect(isChromeCdpOwnedByPid(baseUrl, 44001, 100)).resolves.toBe(true);
        await expect(isChromeCdpOwnedByPid(baseUrl, 44002, 100)).resolves.toBe(false);
      },
    });
  });

  it("does not mistake ChildProcess.killed for process exit", async () => {
    const proc = makeChromeTestProc({ killed: true });
    await stopChromeWithProc(proc, 10);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    { label: "exited", proc: makeChromeTestProc({ exitCode: 0 }) },
    { label: "signaled", proc: makeChromeTestProc({ signalCode: "SIGTERM" }) },
  ])("does not close a reused CDP port after the tracked process has $label", async ({ proc }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await stopChromeWithProc(proc, 10);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("stopOpenClawChrome asks Chrome to close gracefully before sending a signal", async () => {
    let closeRequested = false;
    const proc = makeChromeTestProc({ exitOnSignal: false });
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/graceful-stop",
      reply: replyToShutdown(proc, () => {
        closeRequested = true;
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      }),
      run: async (baseUrl) => {
        const browserWsUrl = `${baseUrl.replace("http://", "ws://")}/devtools/browser/graceful-stop`;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            if (closeRequested) {
              throw new Error("down");
            }
            return jsonResponse({ webSocketDebuggerUrl: browserWsUrl });
          }),
        );
        await stopChromeWithProc(proc, CHROME_STOP_PROBE_TIMEOUT_MS);

        expect(closeRequested).toBe(true);
        expect(proc.kill).not.toHaveBeenCalled();
      },
    });
  });

  it("stopOpenClawChrome escalates when graceful close leaves CDP reachable", async () => {
    const proc = makeChromeTestProc({ exitOnSignal: "SIGKILL" });
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/stuck-stop",
      reply: replyToShutdown(proc),
      run: async (baseUrl) => {
        const browserWsUrl = `${baseUrl.replace("http://", "ws://")}/devtools/browser/stuck-stop`;
        mockVersionEndpoint(browserWsUrl);
        await stopChromeWithProc(proc, 1);
        expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
        expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      },
    });
  });

  it("returns the exact child when shutdown cannot prove process exit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const proc = makeChromeTestProc({ exitOnSignal: false });

    const error = await stopChromeWithProc(proc, 1).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ManagedChromeCleanupError);
    expect(error).toMatchObject({ running: { pid: proc.pid, proc } });
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("does not close a replacement browser that reused the managed CDP port", async () => {
    const methods: string[] = [];
    const proc = makeChromeTestProc();
    await withMockChromeCdpServer({
      wsPath: "/devtools/browser/replacement",
      reply: (method) => {
        methods.push(method);
        return { processInfo: [{ type: "browser", id: proc.pid + 1 }] };
      },
      run: async (baseUrl) => {
        const browserWsUrl = `${baseUrl.replace("http://", "ws://")}/devtools/browser/replacement`;
        const endpoint = new URL(browserWsUrl);
        const timeoutMs = 10;
        mockVersionEndpoint(browserWsUrl);

        // Node's HTTP socket deadline is native; give this fixture's real upgrade
        // the same clock as the CDP command without racing the host scheduler.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const request = http.request;
        let pendingRequest: ReturnType<typeof http.request> | undefined;
        let clearRequestTimeout: (() => void) | undefined;
        const requestTimer = vi.spyOn(http, "request").mockImplementation((...args) => {
          const pending = request(...args);
          if (pending.getHeader("host") !== endpoint.host || pending.path !== endpoint.pathname) {
            return pending;
          }
          pendingRequest = pending;
          pending.once("socket", (socket) => {
            socket.setTimeout(0);
            const timer = setTimeout(() => pending.emit("timeout"), timeoutMs);
            const clear = () => clearTimeout(timer);
            clearRequestTimeout = clear;
            pending.once("upgrade", clear);
            pending.once("error", clear);
            pending.once("close", clear);
          });
          return pending;
        });
        try {
          await stopChromeWithProc(proc, timeoutMs);

          expect(methods).toEqual(["SystemInfo.getProcessInfo"]);
          expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
        } finally {
          clearRequestTimeout?.();
          pendingRequest?.destroy();
          requestTimer.mockRestore();
          vi.useRealTimers();
        }
      },
    });
  });
});
