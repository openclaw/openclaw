import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "node:dns";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/security-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertChromeMcpCdpTransportAllowed,
  resolveCdpReachabilityPolicy,
} from "./cdp-reachability-policy.js";
import { resolveCdpReachabilityTimeouts } from "./cdp-timeouts.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserProfile } from "./config.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const sleepWithAbortMock = vi.hoisted(() =>
  vi.fn<(delayMs: number, signal?: AbortSignal, options?: { ref?: boolean }) => void>(),
);
const registerManagedProxyBrowserCdpBypassMock = vi.hoisted(() =>
  vi.fn<(url: string) => (() => void) | undefined>(() => undefined),
);

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: (...args: Parameters<typeof actual.sleepWithAbort>) => {
      const pending = actual.sleepWithAbort(...args);
      sleepWithAbortMock(...args);
      return pending;
    },
  };
});

// mock-isolation: Keep managed proxy registration outside the socket fixture.
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

import {
  assertCdpEndpointAllowed,
  type CdpSendFn,
  fetchCdpChecked,
  openCdpWebSocket,
  withCdpSocket,
  fetchJson,
  resolveCdpTabOwnership,
  scopeCdpPolicyToConfiguredEndpoint,
} from "./cdp.helpers.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

const remoteOwnership = {
  profileName: "remote",
  cdpUrl: "https://1.1.1.1",
  nativeTargetId: "TARGET-1",
};
const strictRemotePolicy = {
  dangerouslyAllowPrivateNetwork: false,
  allowedHostnames: ["1.1.1.1"],
};
const { resolvePinnedHostnameWithPolicy } = await vi.importActual<
  typeof import("openclaw/plugin-sdk/security-runtime")
>("openclaw/plugin-sdk/security-runtime");

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return release;
}

function mockVersion(webSocketDebuggerUrl: string) {
  return mockResponse(new Response(JSON.stringify({ webSocketDebuggerUrl })));
}

function createLookupFn(address: string): LookupFn {
  const result: LookupAddress = { address, family: address.includes(":") ? 6 : 4 };
  function lookup(_hostname: string, family: number): Promise<LookupAddress>;
  function lookup(_hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
  function lookup(_hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  function lookup(
    _hostname: string,
    options: LookupOptions,
  ): Promise<LookupAddress | LookupAddress[]>;
  function lookup(_hostname: string): Promise<LookupAddress>;
  async function lookup(_hostname: string, options?: number | LookupOptions) {
    return typeof options === "object" && options.all ? [result] : result;
  }
  return lookup;
}

describe("CDP discovery and ownership", () => {
  it("rejects oversized CDP JSON responses before parsing", async () => {
    const release = mockResponse(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await expect(fetchJson("http://127.0.0.1:9222/json/version")).rejects.toThrow(
      "cdp-json: JSON response exceeds 16777216 bytes",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("adds exact loopback hosts to the CDP hostname allowlist", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["*.corp.example"],
      }),
    ).resolves.toEqual(
      expect.objectContaining({ hostname: "127.0.0.1", lookup: expect.any(Function) }),
    );
  });

  it("preserves broad private authority permission through exact-host scoping", async () => {
    const policy = scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {
      allowPrivateNetwork: true,
    });
    await expect(
      assertCdpEndpointAllowed("ws://127.0.0.1:9333/devtools/browser/local", policy, {
        source: "discovered",
        configuredUrl: "http://127.0.0.1:9222",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ hostname: "127.0.0.1", lookup: expect.any(Function) }),
    );
  });

  it("does not turn a strict remote CDP hostname into a private-network grant", async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    const scoped = scopeCdpPolicyToConfiguredEndpoint("https://browser.example:9222", policy);
    expect(scoped).toBe(policy);
    await expect(
      resolvePinnedHostnameWithPolicy("browser.example", {
        policy: scoped,
        lookupFn: createLookupFn("10.0.0.8"),
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("blocks a discovered endpoint on another port in strict SSRF mode", async () => {
    await expect(
      assertCdpEndpointAllowed(
        "ws://127.0.0.1:22/devtools/browser/local",
        scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {}),
        { source: "discovered", configuredUrl: "http://127.0.0.1:9222" },
      ),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("keeps browser-instance fingerprints on the advertised websocket identity", async () => {
    const release = mockVersion("ws://127.0.0.1:9222/devtools/browser/BROWSER-SIDECAR");
    await expect(
      resolveCdpTabOwnership({
        ...remoteOwnership,
        ssrfPolicy: strictRemotePolicy,
      }),
    ).resolves.toMatchObject({
      status: "durable",
      nativeTargetId: "TARGET-1",
      browserInstanceFingerprint:
        "sha256:6eb6cb69267d17a1f2fbf755b1b5c681ddd023c458f6e0f14b3f30848c566ee3",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toBe(strictRemotePolicy);
  });

  it("still blocks ownership when discovery advertises a different remote authority", async () => {
    mockVersion("ws://evil.example:9223/devtools/browser/BROWSER-SIDECAR");
    await expect(
      resolveCdpTabOwnership({ ...remoteOwnership, ssrfPolicy: strictRemotePolicy }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("classifies browser identity network failures without hiding caller aborts", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("version lookup timed out"));
    await expect(resolveCdpTabOwnership(remoteOwnership)).resolves.toEqual({
      status: "non-durable",
      reason: "browser-identity-lookup-failed",
    });
    const controller = new AbortController();
    const abortError = new Error("caller stopped ownership lookup");
    fetchWithSsrFGuardMock.mockImplementationOnce(
      async ({ signal }: { signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error("ownership lookup aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const pending = resolveCdpTabOwnership({ ...remoteOwnership, signal: controller.signal });
    controller.abort(abortError);
    await expect(pending).rejects.toBe(abortError);
  });
});

describe("resolveCdpReachabilityTimeouts", () => {
  function expectTimeouts(
    params: Partial<Parameters<typeof resolveCdpReachabilityTimeouts>[0]>,
    httpTimeoutMs: number,
    wsTimeoutMs: number,
  ) {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        remoteHttpTimeoutMs: 1500,
        remoteHandshakeTimeoutMs: 3000,
        ...params,
      }),
    ).toEqual({ httpTimeoutMs, wsTimeoutMs });
  }

  it("uses loopback defaults when timeout is omitted", () => {
    expectTimeouts({ profileIsLoopback: true }, 300, 600);
  });

  it("uses remote defaults when timeout is omitted", () => {
    expectTimeouts({ remoteHttpTimeoutMs: 1750, remoteHandshakeTimeoutMs: 3250 }, 1750, 3250);
  });

  it("caps remote reachability timeouts to timer-safe values", () => {
    expectTimeouts(
      {
        timeoutMs: Number.MAX_SAFE_INTEGER,
        remoteHttpTimeoutMs: Number.MAX_SAFE_INTEGER,
        remoteHandshakeTimeoutMs: Number.MAX_SAFE_INTEGER,
      },
      MAX_TIMER_TIMEOUT_MS,
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

function createProfile(overrides: Partial<ResolvedBrowserProfile> = {}): ResolvedBrowserProfile {
  return {
    name: "remote",
    cdpPort: 9223,
    cdpUrl: "http://172.29.128.1:9223",
    cdpHost: "172.29.128.1",
    cdpIsLoopback: false,
    color: "#123456",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
    headless: overrides.headless ?? false,
  };
}

const localCdp = { cdpUrl: "http://127.0.0.1:9222", cdpHost: "127.0.0.1", cdpIsLoopback: true };
const chromeProfile = createProfile({ ...localCdp, driver: "existing-session" });

describe("CDP reachability policy", () => {
  it("keeps the default remote CDP policy strict without widening browser navigation policy", async () => {
    const policy = {};
    expect(resolveCdpReachabilityPolicy(createProfile(), policy)).toBe(policy);
    expect(policy).toStrictEqual({});
    await expect(
      assertBrowserNavigationAllowed({ url: "http://172.29.128.1/", ssrfPolicy: policy }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("preserves a private-network policy that rejects the selected CDP host", () => {
    const policy = { allowPrivateNetwork: true, allowedHostnames: ["metadata.internal"] };
    expect(resolveCdpReachabilityPolicy(createProfile(), policy)).toBe(policy);
    expect(policy).toEqual({ allowPrivateNetwork: true, allowedHostnames: ["metadata.internal"] });
  });

  it("normalizes the selected CDP host before narrowing wildcard policy", () => {
    expect(
      resolveCdpReachabilityPolicy(
        createProfile({
          cdpUrl: "https://browser.corp.example.:9222",
          cdpHost: "browser.corp.example.",
        }),
        { allowedHostnames: ["*.corp.example"], allowedOrigins: ["https://navigation.example"] },
      ),
    ).toEqual({ allowedHostnames: ["browser.corp.example"] });
  });

  it("narrows the global wildcard allowlist to the selected CDP host", () => {
    expect(resolveCdpReachabilityPolicy(createProfile(), { allowedHostnames: ["*."] })).toEqual({
      allowedHostnames: ["172.29.128.1"],
    });
  });

  it("narrows configured extension loopback outside navigation allowlist", () => {
    expect(
      resolveCdpReachabilityPolicy(createProfile({ ...localCdp, driver: "extension" }), {
        allowedHostnames: ["*.corp.example"],
      }),
    ).toEqual({ allowedHostnames: ["127.0.0.1"] });
  });

  it.each([
    ["cdpUrl", { cdpUrl: "http://127.0.0.1:9222" }],
    ["--browserUrl", { mcpArgs: ["--browserUrl", "http://127.0.0.1:9222"] }],
    ["--wsEndpoint", { mcpArgs: ["--wsEndpoint=ws://127.0.0.1:9222"] }],
  ])("rejects Chrome MCP explicit %s endpoints under the default policy", (_source, endpoint) => {
    const profile = resolveProfile(
      resolveBrowserConfig({
        profiles: { chrome: { driver: "existing-session", ...endpoint } },
      }),
      "chrome",
    );
    if (!profile) {
      throw new Error("Expected configured Chrome MCP profile");
    }
    expect(() => assertChromeMcpCdpTransportAllowed(profile, {})).toThrow(
      /cannot carry that pinned transport/i,
    );
  });

  it("rejects Chrome MCP explicit CDP URL profiles after default CDP scoping", () => {
    const policy = resolveCdpReachabilityPolicy(chromeProfile, {});
    expect(policy).toEqual({ allowedHostnames: ["127.0.0.1"] });
    expect(() => assertChromeMcpCdpTransportAllowed(chromeProfile, policy)).toThrow(
      /cannot carry that pinned transport/i,
    );
  });

  it("preserves Chrome MCP explicit CDP URL profiles when private CDP endpoints are trusted", () => {
    expect(() =>
      assertChromeMcpCdpTransportAllowed(chromeProfile, { dangerouslyAllowPrivateNetwork: true }),
    ).not.toThrow();
  });

  it("does not let trusted private CDP policy override endpoint allowlists for Chrome MCP", () => {
    expect(() =>
      assertChromeMcpCdpTransportAllowed(chromeProfile, {
        dangerouslyAllowPrivateNetwork: true,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).toThrow(/cannot carry that pinned transport/i);
  });
});

const ownershipParams = {
  ...remoteOwnership,
  cdpUrl: "https://browser.example",
};

describe("CDP ownership fingerprints", () => {
  it("ignores rotated endpoint credentials", async () => {
    async function resolve(value: string) {
      mockVersion(
        `wss://fixture-user:${value}@browser.example/devtools/browser/BROWSER-1?auth=${value}`,
      );
      return resolveCdpTabOwnership({
        ...ownershipParams,
        cdpUrl: `https://fixture-user:${value}@browser.example?auth=${value}`,
      });
    }
    const first = await resolve("fixture-value-a-with-more-than-eighteen-characters");
    const rotated = await resolve("fixture-value-b-with-more-than-eighteen-characters");
    expect(first.status).toBe("durable");
    expect(first).toEqual(rotated);
  });

  it("refuses provider paths that may embed credentials", async () => {
    mockVersion("wss://browser.example/session/fixture-value/devtools/browser/BROWSER-1");
    const unavailable = { status: "non-durable", reason: "browser-identity-unavailable" };
    await expect(resolveCdpTabOwnership(ownershipParams)).resolves.toEqual(unavailable);
    mockVersion("wss://browser.example/devtools/browser/BROWSER-1");
    await expect(
      resolveCdpTabOwnership({
        ...ownershipParams,
        cdpUrl: `https://browser.example/session/${"fixture-path-segment-".repeat(4)}`,
      }),
    ).resolves.toEqual(unavailable);
  });
});

const servers: Array<Server | WebSocketServer> = [];
const fixtureAuthorization = `Basic ${Buffer.from("openclaw:cdp-abort-test").toString("base64")}`;
const retryOptions = { handshakeRetries: 2, handshakeRetryDelayMs: 1, handshakeMaxRetryDelayMs: 1 };
type WsOptions = NonNullable<ConstructorParameters<typeof WebSocketServer>[0]>;
type CdpMessage = { id: number; method: string };

function port(server: Server | WebSocketServer) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP listener");
  }
  return address.port;
}

function wsUrl(server: Server | WebSocketServer, host = "127.0.0.1") {
  return `ws://${host}:${port(server)}/devtools/browser/TEST`;
}

async function startWsServer(options: WsOptions = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", ...options });
  servers.push(server);
  await once(server, "listening");
  return server;
}

async function startHttpServer() {
  const server = createServer();
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function onCommand(
  server: WebSocketServer,
  reply: (message: CdpMessage, socket: WebSocket) => void,
) {
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      reply(JSON.parse(rawDataToString(raw)) as CdpMessage, socket);
    }),
  );
}

function pinnedLookupMock(address = "127.0.0.1") {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") {
      if (typeof options === "object" && options !== null && "all" in options) {
        cb(null, [{ address, family }]);
        return undefined as never;
      }
      cb(null, address, family);
    }
    return undefined as never;
  });
}

async function expectPromptCancellation(pending: Promise<unknown>) {
  const overdue = Promise.withResolvers<never>();
  const timeout = setTimeout(
    () => overdue.reject(new Error("CDP cancellation deadline exceeded")),
    300,
  );
  try {
    await expect(Promise.race([pending, overdue.promise])).rejects.toThrow(
      "browser request cancelled",
    );
  } finally {
    clearTimeout(timeout);
  }
}

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  sleepWithAbortMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockReset();
  registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

describe("guarded CDP fetch", () => {
  it("throws on non-http/https/ws/wss protocols under any SSRF policy", async () => {
    await expect(
      assertCdpEndpointAllowed("ftp://example.com/cdp", {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).rejects.toThrow(/Invalid CDP URL protocol: ftp/);
  });

  it("releases once even when cancelling the unread response fails", async () => {
    const response = new Response("unread");
    if (!response.body) {
      throw new Error("expected a response body");
    }
    const cancel = vi
      .spyOn(response.body, "cancel")
      .mockRejectedValueOnce(new Error("cancellation failed"));
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
    const checked = await fetchCdpChecked("http://127.0.0.1:9222/json/version");
    await expect(checked.release()).resolves.toBeUndefined();
    await checked.release();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(release.mock.invocationCallOrder[0]!);
  });

  it("registers a managed-proxy bypass for the exact sanitized fetch URL", async () => {
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(),
      release: vi.fn(async () => {}),
    });
    const checked = await fetchCdpChecked(
      "http://openclaw:secret@127.0.0.1:9222/json/version",
      undefined,
      undefined,
      { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["*.corp.example"] },
    );
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toEqual({
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["127.0.0.1"],
    });
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/version",
    );
    expect(release).toHaveBeenCalledOnce();
    await checked.release();
  });

  it("converts SSRF-blocked errors into a browser-scoped error", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new SsrFBlockedError("blocked by policy"));
    await expect(fetchCdpChecked("http://127.0.0.1:9222/json/version")).rejects.toBeInstanceOf(
      BrowserCdpEndpointBlockedError,
    );
  });
});

describe("CDP websocket transport", () => {
  it("preserves IPv6 hostnames in pinned WebSocket agent checks", async () => {
    let server: WebSocketServer;
    try {
      server = await startWsServer({ host: "::1" });
    } catch {
      return;
    }
    const ws = openCdpWebSocket(wsUrl(server, "[::1]"), {
      lookup: pinnedLookupMock("::1") as never,
    });
    try {
      await once(ws, "open");
    } finally {
      ws.close();
    }
  });

  it("blocks pinned WebSocket redirects before connecting to a new authority", async () => {
    const target = await startHttpServer();
    const redirect = await startHttpServer();
    const targetConnection = vi.fn();
    target.on("connection", targetConnection);
    redirect.on("upgrade", (_request, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${wsUrl(target)}\r\nConnection: close\r\n\r\n`);
    });
    const ws = openCdpWebSocket(wsUrl(redirect, "cdp-pinned.test"), {
      lookup: pinnedLookupMock() as never,
      playwrightTransportDefaults: true,
    });
    try {
      const error = await new Promise<Error>((resolve, reject) => {
        ws.once("open", () => reject(new Error("redirect unexpectedly opened")));
        ws.once("error", resolve);
      });
      expect(error.message).toContain("CDP WebSocket redirect changed authority");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(targetConnection).not.toHaveBeenCalled();
    } finally {
      ws.close();
    }
  });

  it("ignores malformed and uncorrelated messages before the matching response", async () => {
    const server = await startWsServer();
    const received = vi.fn();
    onCommand(server, (message, socket) => {
      received();
      socket.send(JSON.stringify({ id: "oops", method: "unrelated" }));
      socket.send("not-json");
      socket.send(JSON.stringify({ id: 99999, result: {} }));
      socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
    });
    await expect(withCdpSocket(wsUrl(server), (send) => send("Test.ping"))).resolves.toEqual({
      echoed: "Test.ping",
    });
    expect(received).toHaveBeenCalledOnce();
  });

  it("rejects in-flight calls without retrying when the socket closes", async () => {
    const server = await startWsServer();
    const callback = vi.fn(async (send: CdpSendFn) => send("Test.willClose"));
    const connection = vi.fn();
    server.on("connection", connection);
    onCommand(server, (_message, socket) => {
      setImmediate(() => socket.close());
    });
    await expect(withCdpSocket(wsUrl(server), callback, retryOptions)).rejects.toThrow(
      /CDP socket closed/,
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(connection).toHaveBeenCalledOnce();
  });

  it("retries websocket failures before any CDP command is sent", async () => {
    let rejectedHandshakes = 0;
    const server = await startWsServer({
      verifyClient: (_info, callback) => {
        if (rejectedHandshakes === 0) {
          rejectedHandshakes++;
          callback(false, 503, "try later");
        } else {
          callback(true);
        }
      },
    });
    onCommand(server, (message, socket) =>
      socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } })),
    );
    const callback = vi.fn(async (send: CdpSendFn) => send("Test.afterOpen"));
    await expect(withCdpSocket(wsUrl(server), callback, retryOptions)).resolves.toEqual({
      echoed: "Test.afterOpen",
    });
    expect(rejectedHandshakes).toBe(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("aborts an authenticated 503 retry before opening another socket", async () => {
    const controller = new AbortController();
    let rejectedHandshakes = 0;
    const server = await startWsServer({
      verifyClient: (info, callback) => {
        if (info.req.headers.authorization !== fixtureAuthorization) {
          callback(false, 401);
          return;
        }
        rejectedHandshakes++;
        callback(false, 503, "try later");
      },
    });
    const sleeping = Promise.withResolvers<void>();
    sleepWithAbortMock.mockImplementationOnce(() => sleeping.resolve());
    const pending = withCdpSocket(
      wsUrl(server, "openclaw:cdp-abort-test@127.0.0.1"),
      async () => "unexpected",
      {
        handshakeRetries: 3,
        handshakeRetryDelayMs: 2000,
        handshakeMaxRetryDelayMs: 2000,
        signal: controller.signal,
      },
    );
    await sleeping.promise;
    controller.abort(new Error("browser request cancelled"));
    await expectPromptCancellation(pending);
    expect(rejectedHandshakes).toBe(1);
  });

  it("closes an authenticated socket when its opening handshake is aborted", async () => {
    const controller = new AbortController();
    const server = await startHttpServer();
    const sockets = new Set<Socket>();
    const upgraded = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("end", () => socket.destroy());
      socket.once("close", () => {
        sockets.delete(socket);
        closed.resolve();
      });
    });
    server.on("upgrade", (request, socket) => {
      if (request.headers.authorization !== fixtureAuthorization) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      socket.resume();
      upgraded.resolve();
    });
    try {
      const pending = withCdpSocket(
        wsUrl(server, "openclaw:cdp-abort-test@127.0.0.1"),
        async () => "unexpected",
        {
          handshakeTimeoutMs: 2000,
          handshakeRetries: 0,
          signal: controller.signal,
        },
      );
      await upgraded.promise;
      controller.abort(new Error("browser request cancelled"));
      await expectPromptCancellation(pending);
      await closed.promise;
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
  });

  it("keeps an admitted write socket available for compensation after caller abort", async () => {
    const server = await startWsServer();
    const controller = new AbortController();
    const cancellation = new Error("browser request cancelled after target creation");
    const commands: string[] = [];
    onCommand(server, (message, socket) => {
      commands.push(message.method);
      if (message.method === "Target.createTarget") {
        controller.abort(cancellation);
      }
      socket.send(JSON.stringify({ id: message.id, result: { targetId: "created-target" } }));
    });
    await expect(
      withCdpSocket(
        wsUrl(server),
        async (send) => {
          const created = (await send("Target.createTarget", { url: "about:blank" })) as {
            targetId: string;
          };
          try {
            controller.signal.throwIfAborted();
          } catch (error) {
            await send("Target.closeTarget", { targetId: created.targetId });
            throw error;
          }
        },
        { signal: controller.signal, commandTimeoutMs: 1000 },
      ),
    ).rejects.toBe(cancellation);
    expect(commands).toEqual(["Target.createTarget", "Target.closeTarget"]);
  });

  it("rejects and closes the socket when a CDP command exceeds its timeout", async () => {
    const server = await startWsServer();
    const closed = Promise.withResolvers<void>();
    server.on("connection", (socket) => socket.once("close", () => closed.resolve()));
    await expect(
      withCdpSocket(wsUrl(server), (send) => send("Page.captureScreenshot"), {
        commandTimeoutMs: 5,
      }),
    ).rejects.toThrow(/CDP command Page\.captureScreenshot timed out after 5ms/);
    await closed.promise;
  });

  it("rejects and rethrows when the WebSocket fails to open", async () => {
    await expect(
      withCdpSocket("ws://127.0.0.1:1/devtools/browser/NO", async () => "unreachable"),
    ).rejects.toThrow(/ECONNREFUSED|CDP socket closed/);
  });

  it("keeps WebSocket credentials out of the URL and managed-proxy bypass", async () => {
    const server = await startWsServer();
    const authorization = Promise.withResolvers<string | undefined>();
    server.once("connection", (socket, request) => {
      authorization.resolve(request.headers.authorization);
      socket.close();
    });
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValueOnce(release);
    const ws = openCdpWebSocket(wsUrl(server, "alice:p%40ss@127.0.0.1"), {
      handshakeTimeoutMs: 500,
    });
    try {
      await once(ws, "open");
      expect(ws.url).toBe(wsUrl(server));
      expect(await authorization.promise).toBe(
        `Basic ${Buffer.from("alice:p@ss").toString("base64")}`,
      );
      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(wsUrl(server));
      expect(release).toHaveBeenCalledOnce();
    } finally {
      ws.close();
    }
  });
});
