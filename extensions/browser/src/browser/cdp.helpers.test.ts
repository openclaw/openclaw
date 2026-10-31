import { once } from "node:events";
import type { Socket } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { SsrFBlockedError, type SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertChromeMcpCdpTransportAllowed,
  resolveCdpReachabilityPolicy,
} from "./cdp-reachability-policy.js";
import { resolveCdpReachabilityTimeouts } from "./cdp-timeouts.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  sleep: vi.fn<(delayMs: number, signal?: AbortSignal, options?: { ref?: boolean }) => void>(),
  bypass: vi.fn<(url: string) => (() => void) | undefined>(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: (...args: Parameters<typeof actual.sleepWithAbort>) => {
      const pending = actual.sleepWithAbort(...args);
      mocks.sleep(...args);
      return pending;
    },
  };
});

// mock-isolation: Keep managed proxy registration outside the socket fixture.
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: mocks.bypass,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => mocks.fetch(...args),
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
import { createCdpFixture, wsUrl } from "./cdp.test-support.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

type OwnershipOptions = Partial<Parameters<typeof resolveCdpTabOwnership>[0]>;
const ownership = (options: OwnershipOptions = {}) =>
  resolveCdpTabOwnership({ ...remoteOwnership, ...options });

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
  mocks.fetch.mockResolvedValueOnce({ response, release });
  return release;
}

function mockVersion(webSocketDebuggerUrl: string) {
  return mockResponse(new Response(JSON.stringify({ webSocketDebuggerUrl })));
}
function discoveredEndpoint(port: number, policy: SsrFPolicy = {}) {
  const configuredUrl = "http://127.0.0.1:9222";
  return assertCdpEndpointAllowed(
    `ws://127.0.0.1:${port}/devtools/browser/local`,
    scopeCdpPolicyToConfiguredEndpoint(configuredUrl, policy),
    { source: "discovered", configuredUrl },
  );
}

it("rejects oversized CDP JSON responses before parsing", async () => {
  const release = mockResponse(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
  await expect(fetchJson("http://127.0.0.1:9222/json/version")).rejects.toThrow(
    "cdp-json: JSON response exceeds 16777216 bytes",
  );
  expect(release).toHaveBeenCalledOnce();
});

it("preserves broad private authority permission through exact-host scoping", async () => {
  await expect(discoveredEndpoint(9333, { allowPrivateNetwork: true })).resolves.toMatchObject({
    hostname: "127.0.0.1",
    lookup: expect.any(Function),
  });
});

it("does not turn a strict remote CDP hostname into a private-network grant", async () => {
  const policy = { dangerouslyAllowPrivateNetwork: false };
  const scoped = scopeCdpPolicyToConfiguredEndpoint("https://browser.example:9222", policy);
  expect(scoped).toBe(policy);
  await expect(
    resolvePinnedHostnameWithPolicy("browser.example", {
      policy: scoped,
      lookupFn: async () => [{ address: "10.0.0.8", family: 4 }],
    }),
  ).rejects.toThrow(/private\/internal\/special-use ip address/i);
});

it("blocks a discovered endpoint on another port in strict SSRF mode", async () => {
  await expect(discoveredEndpoint(22)).rejects.toThrow("browser endpoint blocked by policy");
});

it("keeps browser-instance fingerprints on the advertised websocket identity", async () => {
  const release = mockVersion("ws://127.0.0.1:9222/devtools/browser/BROWSER-SIDECAR");
  await expect(ownership({ ssrfPolicy: strictRemotePolicy })).resolves.toMatchObject({
    status: "durable",
    nativeTargetId: "TARGET-1",
    browserInstanceFingerprint:
      "sha256:6eb6cb69267d17a1f2fbf755b1b5c681ddd023c458f6e0f14b3f30848c566ee3",
  });
  expect(release).toHaveBeenCalledOnce();
  expect(mocks.fetch.mock.calls[0]?.[0]?.policy).toBe(strictRemotePolicy);
});

it("still blocks ownership when discovery advertises a different remote authority", async () => {
  mockVersion("ws://evil.example:9223/devtools/browser/BROWSER-SIDECAR");
  await expect(ownership({ ssrfPolicy: strictRemotePolicy })).rejects.toBeInstanceOf(
    BrowserCdpEndpointBlockedError,
  );
});

it("classifies browser identity network failures without hiding caller aborts", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("version lookup timed out"));
  await expect(ownership()).resolves.toEqual({
    status: "non-durable",
    reason: "browser-identity-lookup-failed",
  });
  const controller = new AbortController();
  const abortError = new Error("caller stopped ownership lookup");
  mocks.fetch.mockImplementationOnce(
    async ({ signal }: { signal: AbortSignal }) =>
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new Error("ownership lookup aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  );
  const pending = ownership({ signal: controller.signal });
  controller.abort(abortError);
  await expect(pending).rejects.toBe(abortError);
});
type Overrides = Partial<Parameters<typeof resolveCdpReachabilityTimeouts>[0]>;
const huge = Number.MAX_SAFE_INTEGER;
it.each([
  [{ profileIsLoopback: true }, 300, 600],
  [{ remoteHttpTimeoutMs: 1750, remoteHandshakeTimeoutMs: 3250 }, 1750, 3250],
  [
    {
      timeoutMs: huge,
      remoteHttpTimeoutMs: huge,
      remoteHandshakeTimeoutMs: huge,
    },
    MAX_TIMER_TIMEOUT_MS,
    MAX_TIMER_TIMEOUT_MS,
  ],
] satisfies [Overrides, number, number][])("resolves %j", (params, httpTimeoutMs, wsTimeoutMs) => {
  expect(
    resolveCdpReachabilityTimeouts({
      profileIsLoopback: false,
      remoteHttpTimeoutMs: 1500,
      remoteHandshakeTimeoutMs: 3000,
      ...params,
    }),
  ).toEqual({ httpTimeoutMs, wsTimeoutMs });
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

it("narrows the global wildcard allowlist to the normalized CDP host", () => {
  expect(
    resolveCdpReachabilityPolicy(
      createProfile({
        cdpUrl: "https://browser.corp.example.:9222",
        cdpHost: "browser.corp.example.",
      }),
      { allowedHostnames: ["*."], allowedOrigins: ["https://navigation.example"] },
    ),
  ).toEqual({ allowedHostnames: ["browser.corp.example"] });
});

it("narrows configured extension loopback outside navigation allowlist", () => {
  expect(
    resolveCdpReachabilityPolicy(createProfile({ ...localCdp, driver: "extension" }), {
      allowedHostnames: ["*.corp.example"],
    }),
  ).toEqual({ allowedHostnames: ["127.0.0.1"] });
});

it("rejects Chrome MCP explicit CDP URL profiles after default CDP scoping", () => {
  const policy = resolveCdpReachabilityPolicy(chromeProfile, {});
  expect(policy).toEqual({ allowedHostnames: ["127.0.0.1"] });
  expect(() => assertChromeMcpCdpTransportAllowed(chromeProfile, policy)).toThrow(
    /cannot carry that pinned transport/i,
  );
});

const ownershipParams = { cdpUrl: "https://browser.example" };

it("ignores rotated endpoint credentials", async () => {
  async function resolve(value: string) {
    mockVersion(
      `wss://fixture-user:${value}@browser.example/devtools/browser/BROWSER-1?auth=${value}`,
    );
    return ownership({
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
  await expect(ownership(ownershipParams)).resolves.toEqual(unavailable);
  mockVersion("wss://browser.example/devtools/browser/BROWSER-1");
  await expect(
    ownership({
      cdpUrl: `https://browser.example/session/${"fixture-path-segment-".repeat(4)}`,
    }),
  ).resolves.toEqual(unavailable);
});

const {
  listenWs: startWsServer,
  listenHttp: startHttpServer,
  close: closeServers,
} = createCdpFixture({});
const clientSockets: WebSocket[] = [];
function openTrackedSocket(...args: Parameters<typeof openCdpWebSocket>) {
  const socket = openCdpWebSocket(...args);
  clientSockets.push(socket);
  return socket;
}
const fixtureAuthorization = `Basic ${Buffer.from("openclaw:cdp-abort-test").toString("base64")}`;
type CdpMessage = { id: number; method: string };

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
  mocks.fetch.mockReset();
  mocks.sleep.mockReset();
  mocks.bypass.mockReset();
  mocks.bypass.mockImplementation(() => undefined);
  vi.restoreAllMocks();
  for (const socket of clientSockets.splice(0)) {
    socket.close();
  }
  await closeServers();
});

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
  const release = mockResponse(response);
  const checked = await fetchCdpChecked("http://127.0.0.1:9222/json/version");
  await expect(checked.release()).resolves.toBeUndefined();
  await checked.release();
  expect(cancel).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(release.mock.invocationCallOrder[0]!);
});

it("registers a managed-proxy bypass for the exact sanitized fetch URL", async () => {
  const release = vi.fn();
  mocks.bypass.mockReturnValueOnce(release);
  mockResponse(new Response());
  const checked = await fetchCdpChecked(
    "http://openclaw:secret@127.0.0.1:9222/json/version",
    undefined,
    undefined,
    { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["*.corp.example"] },
  );
  expect(mocks.fetch.mock.calls[0]?.[0]?.policy).toEqual({
    dangerouslyAllowPrivateNetwork: false,
    allowedHostnames: ["127.0.0.1"],
  });
  expect(mocks.bypass).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version");
  expect(release).toHaveBeenCalledOnce();
  await checked.release();
});

it("converts SSRF-blocked errors into a browser-scoped error", async () => {
  mocks.fetch.mockRejectedValueOnce(new SsrFBlockedError("blocked by policy"));
  await expect(fetchCdpChecked("http://127.0.0.1:9222/json/version")).rejects.toBeInstanceOf(
    BrowserCdpEndpointBlockedError,
  );
});
it("preserves IPv6 hostnames in pinned WebSocket agent checks", async () => {
  let server: WebSocketServer;
  try {
    server = await startWsServer({ host: "::1" });
  } catch {
    return;
  }
  const ws = openTrackedSocket(wsUrl(server, "[::1]"), {
    lookup: pinnedLookupMock("::1") as never,
  });
  await once(ws, "open");
});

it("blocks pinned WebSocket redirects before connecting to a new authority", async () => {
  const target = await startHttpServer();
  const redirect = await startHttpServer();
  const targetConnection = vi.fn();
  target.on("connection", targetConnection);
  redirect.on("upgrade", (_request, socket) => {
    socket.end(`HTTP/1.1 302 Found\r\nLocation: ${wsUrl(target)}\r\nConnection: close\r\n\r\n`);
  });
  const ws = openTrackedSocket(wsUrl(redirect, "cdp-pinned.test"), {
    lookup: pinnedLookupMock() as never,
    playwrightTransportDefaults: true,
  });
  const error = await new Promise<Error>((resolve, reject) => {
    ws.once("open", () => reject(new Error("redirect unexpectedly opened")));
    ws.once("error", resolve);
  });
  expect(error.message).toContain("CDP WebSocket redirect changed authority");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  expect(targetConnection).not.toHaveBeenCalled();
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

it.each([
  ["closes", "Test.willClose", {}, /CDP socket closed/],
  [
    "times out",
    "Page.captureScreenshot",
    { commandTimeoutMs: 5 },
    /CDP command Page\.captureScreenshot timed out after 5ms/,
  ],
] as const)(
  "rejects once and releases the socket when a command %s",
  async (mode, method, options, error) => {
    const server = await startWsServer();
    const connection = vi.fn();
    const closed = Promise.withResolvers<void>();
    server.on("connection", connection);
    server.on("connection", (socket) => socket.once("close", () => closed.resolve()));
    onCommand(server, (_message, socket) => {
      if (mode === "closes") {
        setImmediate(() => socket.close());
      }
    });
    await expect(withCdpSocket(wsUrl(server), (send) => send(method), options)).rejects.toThrow(
      error,
    );
    await closed.promise;
    expect(connection).toHaveBeenCalledOnce();
  },
);

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
  await expect(withCdpSocket(wsUrl(server), callback)).resolves.toEqual({
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
  mocks.sleep.mockImplementationOnce(() => sleeping.resolve());
  const pending = withCdpSocket(
    wsUrl(server, "openclaw:cdp-abort-test@127.0.0.1"),
    async () => "unexpected",
    {
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
  mocks.bypass.mockReturnValueOnce(release);
  const ws = openTrackedSocket(wsUrl(server, "alice:p%40ss@127.0.0.1"), {
    handshakeTimeoutMs: 500,
  });
  await once(ws, "open");
  expect(ws.url).toBe(wsUrl(server));
  expect(await authorization.promise).toBe(`Basic ${Buffer.from("alice:p@ss").toString("base64")}`);
  expect(mocks.bypass).toHaveBeenCalledWith(wsUrl(server));
  expect(release).toHaveBeenCalledOnce();
});
