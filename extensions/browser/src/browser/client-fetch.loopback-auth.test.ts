import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Browser tests cover client fetch.loopback auth plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import "../test-support/browser-security.mock.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserControlAuth } from "./control-auth.js";
import type { BrowserDispatchResponse } from "./routes/dispatcher.js";

type BridgeAuth = NonNullable<
  ReturnType<typeof import("./bridge-auth-registry.js").getBridgeAuthForPort>
>;

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
      release: async () => {},
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

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: mocks.loadConfig,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../control-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../control-service.js")>()),
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: mocks.getBridgeAuthForPort,
}));

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const init = requireFetchInit(fetchMock);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.getBridgeAuthForPort).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "preserves an empty caller password header",
      headers: { "x-openclaw-password": "" },
      registryThrows: false,
      password: "",
      calls: [],
    },
    {
      name: "keeps the unauthenticated request when registry lookup fails",
      headers: undefined,
      registryThrows: true,
      password: null,
      calls: ["registry", "config", "resolve"],
    },
  ])("$name", async (testCase) => {
    const calls: string[] = [];
    mocks.loadConfig.mockImplementation(() => {
      calls.push("config");
      return {};
    });
    mocks.resolveBrowserControlAuth.mockImplementation(() => {
      calls.push("resolve");
      return {};
    });
    mocks.getBridgeAuthForPort.mockImplementation(() => {
      calls.push("registry");
      if (testCase.registryThrows) {
        throw new Error("fixture registry unavailable");
      }
      return undefined;
    });
    const fetchMock = stubJsonFetchOk();
    await expect(
      fetchBrowserJson("http://127.0.0.1:18888/", { headers: testCase.headers }),
    ).resolves.toEqual({ ok: true });
    const headers = new Headers(requireFetchInit(fetchMock)?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-openclaw-password")).toBe(testCase.password);
    expect(calls).toEqual(testCase.calls);
    if (testCase.registryThrows) {
      expect(mocks.getBridgeAuthForPort).toHaveBeenCalledWith(18888);
    }
  });

  it("preserves dispatcher timeout context with retry-once hint", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: [
        "Chrome CDP handshake timeout",
        "openclaw browser doctor",
        "Retry the browser tool once",
        "If the same error persists",
      ],
      omits: ["Can't reach the OpenClaw browser control service", "Do NOT retry the browser tool"],
    });
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
          "Retry the browser tool once",
          "If the same error persists",
        ],
        omits: ["Restart the OpenClaw gateway", "Do NOT retry the browser tool"],
      },
    );
  });

  it("suggests browser diagnostics when dispatcher profile resolution fails", async () => {
    mocks.loadConfig.mockImplementation(() => {
      throw new Error("config unavailable");
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=manual"),
      {
        contains: [
          "Chrome CDP handshake timeout",
          "openclaw browser doctor",
          "Retry the browser tool once",
          "If the same error persists",
        ],
        omits: ["browser profile is external to OpenClaw", "Do NOT retry the browser tool"],
      },
    );
  });

  it("suggests browser diagnostics for unknown dispatcher profiles", async () => {
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
        contains: [
          "Chrome CDP handshake timeout",
          "openclaw browser doctor",
          "Retry the browser tool once",
          "If the same error persists",
        ],
        omits: ["browser profile is external to OpenClaw", "Do NOT retry the browser tool"],
      },
    );
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

  it("uses top-level reset codes to classify dispatcher failures as transient", async () => {
    mocks.dispatch.mockRejectedValueOnce(
      Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    );

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["socket closed", "Retry the browser tool once", "If the same error persists"],
      omits: ["Do NOT retry the browser tool"],
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
        omits: ["rate limit", "Retry the browser tool once", "Do NOT retry the browser tool"],
      },
    );
  });

  it("uses operation metadata rather than timeout wording over HTTP", async () => {
    const body = {
      error: "locator.fill: Timeout 700ms exceeded: element is not editable",
      code: "ACT_OPERATION_FAILED",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 500 })),
    );
    const error = await expectThrownBrowserFetchError(
      () => fetchBrowserJson("http://127.0.0.1:18888/act"),
      {
        contains: [body.error],
        omits: ["Retry the browser tool", "browser is currently unavailable", "Restart"],
      },
    );
    expect(error).toMatchObject({ name: "BrowserServiceError", code: body.code, status: 500 });
  });

  it("keeps authentication failure advice even with operation metadata", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 401,
      body: { error: "Unauthorized", code: "ACT_OPERATION_FAILED" },
    });
    await expectThrownBrowserFetchError(() => fetchBrowserJson("/act"), {
      contains: ["Unauthorized", "Do NOT retry the browser tool"],
      omits: ["Retry the browser tool once"],
    });
  });

  it("keeps pre-annotated persistent payload hints mutually exclusive", async () => {
    const persistentHint =
      "Do NOT retry the browser tool — it will keep failing. Use an alternative approach or inform the user that the browser is currently unavailable.";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: `browser request timed out. ${persistentHint}` }), {
            status: 504,
          }),
      ),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["browser request timed out", persistentHint],
        omits: ["Retry the browser tool once"],
      },
    );
  });

  it("keeps transient dispatcher error payloads retryable once", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 500,
      body: { error: "read ECONNRESET" },
    });

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["read ECONNRESET", "Retry the browser tool once", "If the same error persists"],
      omits: ["Do NOT retry the browser tool"],
    });
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

  it("uses nested reset causes to classify generic fetch failures as transient", async () => {
    const reset = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: reset });
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/"),
      {
        contains: ["fetch failed", "Retry the browser tool once", "If the same error persists"],
        omits: ["Do NOT retry the browser tool"],
      },
    );
  });

  it("uses nested refusal causes to keep unavailable services non-retryable", async () => {
    const refused = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("browser request timed out", { cause: refused });
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/"),
      {
        contains: ["browser request timed out", "Do NOT retry the browser tool"],
        omits: ["Retry the browser tool once"],
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
        contains: [
          "timed out after 5000ms",
          "Retry the browser tool once",
          "If the same error persists",
        ],
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
        contains: [
          `timed out after ${MAX_TIMER_TIMEOUT_MS}ms`,
          "Retry the browser tool once",
          "If the same error persists",
        ],
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
