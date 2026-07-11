// Browser tests cover client fetch.loopback auth plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  SANDBOX_BROWSER_REFRESH_HEADER,
  SANDBOX_BROWSER_REFRESH_VALUE,
} from "./bridge-auth-registry.js";
import type { BrowserControlAuth } from "./control-auth.js";
import type { BrowserDispatchResponse } from "./routes/dispatcher.js";

type BridgeAuth = NonNullable<
  ReturnType<typeof import("./bridge-auth-registry.js").getBridgeAuthForPort>
>;

const ssrfMocks = vi.hoisted(() => ({
  release: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, {
        ...params.init,
        signal: params.signal,
      }),
      finalUrl: params.url,
      release: ssrfMocks.release,
    }),
  };
});

function okDispatchResponse(): BrowserDispatchResponse {
  return { status: 200, body: { ok: true } };
}

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(() => ({
    gateway: {
      auth: {
        token: "loopback-token",
      },
    },
  })),
  resolveBrowserControlAuth: vi.fn<() => BrowserControlAuth>(() => ({
    token: "loopback-token",
  })),
  getBridgeAuthForPort: vi.fn<(port: number) => BridgeAuth | undefined>(() => undefined),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (): Promise<BrowserDispatchResponse> => okDispatchResponse()),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.loadConfig,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("./bridge-auth-registry.js", async () => {
  const actual = await vi.importActual<typeof import("./bridge-auth-registry.js")>(
    "./bridge-auth-registry.js",
  );
  return {
    ...actual,
    getBridgeAuthForPort: mocks.getBridgeAuthForPort,
  };
});

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: mocks.dispatch,
  })),
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

function stubJsonFetchOk() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requireFetchInit(fetchMock: ReturnType<typeof stubJsonFetchOk>) {
  const [call] = fetchMock.mock.calls;
  if (!call) {
    throw new Error("expected browser fetch call");
  }
  const [, init] = call;
  return init;
}

async function expectThrownBrowserFetchError(
  request: () => Promise<unknown>,
  params: {
    contains: string[];
    omits?: string[];
  },
) {
  const thrown = await request().catch((err: unknown) => err);
  expect(thrown).toBeInstanceOf(Error);
  if (!(thrown instanceof Error)) {
    throw new Error(`Expected Error, got ${String(thrown)}`);
  }
  for (const snippet of params.contains) {
    expect(thrown.message).toContain(snippet);
  }
  for (const snippet of params.omits ?? []) {
    expect(thrown.message).not.toContain(snippet);
  }
  return thrown;
}

describe("fetchBrowserJson loopback auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "loopback-token");
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    });
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue({ ok: true });
    mocks.dispatch.mockReset().mockResolvedValue(okDispatchResponse());
    mocks.resolveBrowserControlAuth.mockReset().mockReturnValue({
      token: "loopback-token",
    });
    mocks.getBridgeAuthForPort.mockReset().mockReturnValue(undefined);
    ssrfMocks.release.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("adds bearer auth for loopback absolute HTTP URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    const res = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/");
    expect(res.ok).toBe(true);

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps caller-supplied auth header", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://localhost:18888/", {
      headers: {
        Authorization: "Bearer caller-token",
      },
    });

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-token");
  });

  it("injects auth for IPv6 loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::1]:18888/");

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("injects auth for IPv4-mapped IPv6 loopback URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::ffff:127.0.0.1]:18888/");

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("does not treat explicit port zero as the default loopback bridge port", async () => {
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.getBridgeAuthForPort.mockReturnValueOnce({ token: "bridge-token" });
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:0/");

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(mocks.getBridgeAuthForPort).not.toHaveBeenCalled();
    expect(headers.get("authorization")).toBeNull();
  });

  it("preserves dispatcher timeout context without no-retry hint", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Chrome CDP handshake timeout", "Restart the OpenClaw gateway"],
      omits: ["Can't reach the OpenClaw browser control service", "Do NOT retry the browser tool"],
    });
  });

  it("preserves dispatcher abort context without no-retry hint", async () => {
    mocks.dispatch.mockRejectedValueOnce(new DOMException("operation aborted", "AbortError"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["operation aborted", "Restart the OpenClaw gateway"],
      omits: ["Do NOT retry the browser tool"],
    });
  });

  it("avoids restart-gateway guidance for attachOnly dispatcher timeouts", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        attachOnly: true,
        defaultProfile: "manual",
        profiles: {
          manual: {
            cdpUrl: "http://127.0.0.1:9222",
            attachOnly: true,
            color: "#00AA00",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=manual"),
      {
        contains: [
          "Chrome CDP handshake timeout",
          "browser profile is external to OpenClaw",
          "Restarting the OpenClaw gateway will not launch it",
        ],
        omits: ["Restart the OpenClaw gateway", "Do NOT retry the browser tool"],
      },
    );
  });

  it("avoids restart-gateway guidance for existing-session dispatcher timeouts", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "user",
        profiles: {
          user: {
            driver: "existing-session",
            attachOnly: true,
            color: "#00AA00",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new DOMException("operation aborted", "AbortError"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: [
        "operation aborted",
        "browser profile is external to OpenClaw",
        "Restarting the OpenClaw gateway will not launch it",
      ],
      omits: ["Restart the OpenClaw gateway", "Do NOT retry the browser tool"],
    });
  });

  it("avoids restart-gateway guidance for remote CDP dispatcher timeouts", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "remote",
        profiles: {
          remote: {
            cdpUrl: "https://browserless.example/chrome?token=test",
            color: "#00AA00",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("timed out"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=remote"),
      {
        contains: [
          "timed out",
          "browser profile is external to OpenClaw",
          "Restarting the OpenClaw gateway will not launch it",
        ],
        omits: ["Restart the OpenClaw gateway", "Do NOT retry the browser tool"],
      },
    );
  });

  it("keeps restart-gateway guidance for managed local dispatcher timeouts", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: {
            cdpPort: 18800,
            color: "#FF4500",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=openclaw"),
      {
        contains: ["Chrome CDP handshake timeout", "Restart the OpenClaw gateway"],
        omits: ["browser profile is external to OpenClaw", "Do NOT retry the browser tool"],
      },
    );
  });

  it("keeps restart-gateway guidance when dispatcher profile resolution fails", async () => {
    mocks.loadConfig.mockImplementation(() => {
      throw new Error("config unavailable");
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=manual"),
      {
        contains: ["Chrome CDP handshake timeout", "Restart the OpenClaw gateway"],
        omits: ["browser profile is external to OpenClaw", "Do NOT retry the browser tool"],
      },
    );
  });

  it("keeps restart-gateway guidance for unknown dispatcher profiles", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: {
            cdpPort: 18800,
            color: "#FF4500",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=missing"),
      {
        contains: ["Chrome CDP handshake timeout", "Restart the OpenClaw gateway"],
        omits: ["browser profile is external to OpenClaw", "Do NOT retry the browser tool"],
      },
    );
  });

  it("uses the default external profile when dispatcher request omits profile", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "manual",
        profiles: {
          manual: {
            cdpUrl: "http://127.0.0.1:9222",
            attachOnly: true,
            color: "#00AA00",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: [
        "Chrome CDP handshake timeout",
        "browser profile is external to OpenClaw",
        "Restarting the OpenClaw gateway will not launch it",
      ],
      omits: ["Restart the OpenClaw gateway", "Do NOT retry the browser tool"],
    });
  });

  it("keeps no-retry hint but not restart guidance for persistent external profile failures", async () => {
    mocks.loadConfig.mockReturnValue({
      browser: {
        attachOnly: true,
        defaultProfile: "manual",
        profiles: {
          manual: {
            cdpUrl: "http://127.0.0.1:9222",
            attachOnly: true,
            color: "#00AA00",
          },
        },
      },
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP connection refused"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=manual"),
      {
        contains: [
          "Chrome CDP connection refused",
          "browser profile is external to OpenClaw",
          "Do NOT retry the browser tool",
        ],
        omits: ["Restart the OpenClaw gateway"],
      },
    );
  });

  it("keeps no-retry hint for persistent dispatcher failures", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP connection refused"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Chrome CDP connection refused", "Do NOT retry the browser tool"],
      omits: ["Can't reach the OpenClaw browser control service"],
    });
  });

  it("preserves validated structured errors from dispatcher routes", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 409,
      body: {
        error: "display required",
        reason: "no_display_for_headed_profile",
        details: {
          profile: "openclaw",
          requestedHeadless: false,
          headlessSource: "request",
          displayPresent: false,
        },
      },
    });

    const error = await fetchBrowserJson("/start?headless=false", { method: "POST" }).catch(
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "display required",
      reason: "no_display_for_headed_profile",
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "request",
        displayPresent: false,
      },
    });
  });

  it("surfaces 429 from HTTP URL as rate-limit error with no-retry hint", async () => {
    const response = new Response("max concurrent sessions exceeded", { status: 429 });
    const text = vi.spyOn(response, "text");
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["Browser service rate limit reached", "Do NOT retry the browser tool"],
        omits: ["max concurrent sessions exceeded"],
      },
    );
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("surfaces 429 from HTTP URL without body detail when empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["rate limit reached", "Do NOT retry the browser tool"],
      },
    );
  });

  it("keeps Browserbase-specific wording for Browserbase 429 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("max concurrent sessions exceeded", { status: 429 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("https://connect.browserbase.com/session"),
      {
        contains: ["Browserbase rate limit reached", "upgrade your plan"],
        omits: ["max concurrent sessions exceeded"],
      },
    );
  });

  it("non-429 errors still produce generic messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["internal error"],
        omits: ["rate limit"],
      },
    );
  });

  it("retries a marked registered-bridge POST after releasing the first guard", async () => {
    mocks.getBridgeAuthForPort.mockReturnValue({ token: "bridge-token" });
    const blocked = new Response("refreshing", {
      status: 503,
      headers: {
        [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
        "Retry-After": "0",
      },
    });
    const cancel = vi.spyOn(blocked.body!, "cancel").mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return blocked;
      }
      expect(ssrfMocks.release).toHaveBeenCalledTimes(1);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click" }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ kind: "click" }),
      JSON.stringify({ kind: "click" }),
    ]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(ssrfMocks.release).toHaveBeenCalledTimes(2);
  });

  it("retries an ambiguous reconnect for a read only after a valid refresh marker", async () => {
    mocks.getBridgeAuthForPort.mockReturnValue({ token: "bridge-token" });
    const reconnect = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket reset after response"), { code: "UND_ERR_SOCKET" }),
    });
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("refreshing", {
          status: 503,
          headers: {
            [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
            "Retry-After": "0",
          },
        }),
      )
      .mockRejectedValueOnce(reconnect)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/tabs")).resolves.toEqual(
      { ok: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a pre-connect failure for a POST after a valid refresh marker", async () => {
    mocks.getBridgeAuthForPort.mockReturnValue({ token: "bridge-token" });
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("refreshing", {
          status: 503,
          headers: {
            [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
            "Retry-After": "0",
          },
        }),
      )
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/act", {
        method: "POST",
        body: JSON.stringify({ kind: "click" }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not replay a POST after an ambiguous reconnect failure", async () => {
    mocks.getBridgeAuthForPort.mockReturnValue({ token: "bridge-token" });
    const resetAfterDispatch = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket reset after request dispatch"), {
        code: "UND_ERR_SOCKET",
      }),
    });
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("refreshing", {
          status: 503,
          headers: {
            [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
            "Retry-After": "0",
          },
        }),
      )
      .mockRejectedValueOnce(resetAfterDispatch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ duplicated: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBrowserJson("http://127.0.0.1:18888/act", {
        method: "POST",
        body: JSON.stringify({ kind: "click" }),
      }),
    ).rejects.toThrow("Can't reach the OpenClaw browser control service");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "unmarked registered-bridge response",
      url: "http://127.0.0.1:18888/",
      bridgeAuth: { token: "bridge-token" },
      headers: new Headers(),
    },
    {
      label: "marked non-loopback response",
      url: "https://example.com/",
      bridgeAuth: undefined,
      headers: new Headers({
        [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
      }),
    },
  ])("keeps $label terminal", async ({ url, bridgeAuth, headers }) => {
    mocks.getBridgeAuthForPort.mockReturnValue(bridgeAuth);
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503, headers }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchBrowserJson(url).catch((err: unknown) => err);
    expect(error).toMatchObject({
      name: "BrowserServiceError",
      status: 503,
      message: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses one abort budget while waiting to retry a marked response", async () => {
    mocks.getBridgeAuthForPort.mockReturnValue({ token: "bridge-token" });
    let notifyReleased!: () => void;
    const firstGuardReleased = new Promise<void>((resolve) => {
      notifyReleased = resolve;
    });
    ssrfMocks.release.mockImplementationOnce(async () => {
      notifyReleased();
    });
    const fetchMock = vi.fn(
      async () =>
        new Response("refreshing", {
          status: 503,
          headers: {
            [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
            "Retry-After": "1",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = fetchBrowserJson("http://127.0.0.1:18888/tabs", {
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    await firstGuardReleased;
    controller.abort(new DOMException("operation aborted", "AbortError"));
    await expect(request).rejects.toThrow("Browser control request was cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ssrfMocks.release).toHaveBeenCalledOnce();
  });

  it("keeps refresh retries inside the original timeout budget", async () => {
    mocks.getBridgeAuthForPort.mockReturnValue({ token: "bridge-token" });
    const fetchMock = vi.fn(
      async () =>
        new Response("refreshing", {
          status: 503,
          headers: {
            [SANDBOX_BROWSER_REFRESH_HEADER]: SANDBOX_BROWSER_REFRESH_VALUE,
            "Retry-After": "1",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson("http://127.0.0.1:18888/tabs", { timeoutMs: 50 }),
      { contains: ["timed out after 50ms"], omits: ["Do NOT retry the browser tool"] },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces 429 from dispatcher path as rate-limit error", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 429,
      body: { error: "too many sessions" },
    });

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Browser service rate limit reached", "Do NOT retry the browser tool"],
      omits: ["too many sessions"],
    });
  });

  it("keeps absolute URL failures wrapped as reachability errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/"),
      {
        contains: [
          "Can't reach the OpenClaw browser control service",
          "Do NOT retry the browser tool",
        ],
      },
    );
  });

  it("omits no-retry hint for absolute HTTP timeout failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timed out");
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/", { timeoutMs: 1234 }),
      {
        contains: ["timed out after 1234ms"],
        omits: ["Do NOT retry the browser tool"],
      },
    );
  });

  it("uses the default timeout for non-finite absolute HTTP timeout failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timed out");
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/", { timeoutMs: Number.NaN }),
      {
        contains: ["timed out after 5000ms"],
        omits: ["NaNms", "Do NOT retry the browser tool"],
      },
    );
  });

  it("caps oversized absolute HTTP timeouts before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timed out");
      }),
    );

    await expectThrownBrowserFetchError(
      () =>
        fetchBrowserJson<{ ok: boolean }>("http://example.com/", {
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      {
        contains: [`timed out after ${MAX_TIMER_TIMEOUT_MS}ms`],
        omits: ["Do NOT retry the browser tool"],
      },
    );
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("omits no-retry hint for absolute HTTP abort failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("operation aborted", "AbortError");
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/"),
      {
        contains: ["Browser control request was cancelled"],
        omits: ["Do NOT retry the browser tool"],
      },
    );
  });
});
