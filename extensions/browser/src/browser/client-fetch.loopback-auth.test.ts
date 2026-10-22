import type { BrowserProfileConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

function stubHttpError(body: unknown, status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    ),
  );
}

function stubFetchFailure(error: Error) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

function profileConfig(name: string, profile: BrowserProfileConfig, attachOnly?: boolean) {
  mocks.loadConfig.mockReturnValue({
    browser: {
      defaultProfile: name,
      profiles: { [name]: { color: "#00AA00", ...profile } },
      ...(attachOnly === undefined ? {} : { attachOnly }),
    },
  });
}

function dispatchError(status: number, body: BrowserDispatchResponse["body"]) {
  mocks.dispatch.mockResolvedValueOnce({ status, body });
}

const noRetry = "Do NOT retry the browser tool";
const retry = "Retry the browser tool once";
const noRestart = "Restart the OpenClaw gateway";
const external = "browser profile is external to OpenClaw";
const retryOnce = [retry, "If the same error persists"];
const externalProfile = [external, "Restarting the OpenClaw gateway will not launch it"];

const okDispatchResponse: BrowserDispatchResponse = { status: 200, body: { ok: true } };

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(() => ({
    gateway: { auth: { token: "loopback-token" } },
  })),
  resolveBrowserControlAuth: vi.fn<() => BrowserControlAuth>(() => ({
    token: "loopback-token",
  })),
  getBridgeAuthForPort: vi.fn<(port: number) => BridgeAuth | undefined>(() => undefined),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (): Promise<BrowserDispatchResponse> => okDispatchResponse),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    readRuntimeConfig: mocks.loadConfig,
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
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requireFetchInit(fetchMock: ReturnType<typeof stubJsonFetchOk>) {
  expect(fetchMock).toHaveBeenCalled();
  return fetchMock.mock.calls[0]![1];
}

async function expectThrownBrowserFetchError(
  url: string,
  params: { contains: string[]; omits?: string[] },
  options?: Parameters<typeof fetchBrowserJson>[1],
) {
  const thrown = await fetchBrowserJson(url, options).catch((err: unknown) => err);
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
    for (const scheme of ["ALL", "HTTP", "HTTPS"]) {
      vi.stubEnv(`${scheme}_PROXY`, "");
      vi.stubEnv(`${scheme.toLowerCase()}_proxy`, "");
    }
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "loopback-token");
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({
      gateway: { auth: { token: "loopback-token" } },
    });
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue({ ok: true });
    mocks.dispatch.mockReset().mockResolvedValue(okDispatchResponse);
    mocks.resolveBrowserControlAuth.mockReset().mockReturnValue({ token: "loopback-token" });
    mocks.getBridgeAuthForPort.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const headers = new Headers(requireFetchInit(fetchMock)?.headers);
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

  it("keeps the unauthenticated request when registry lookup fails", async () => {
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
      throw new Error("fixture registry unavailable");
    });
    const fetchMock = stubJsonFetchOk();
    await expect(fetchBrowserJson("http://127.0.0.1:18888/")).resolves.toEqual({ ok: true });
    const headers = new Headers(requireFetchInit(fetchMock)?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-openclaw-password")).toBeNull();
    expect(calls).toEqual(["registry", "config", "resolve"]);
    expect(mocks.getBridgeAuthForPort).toHaveBeenCalledWith(18888);
  });

  it("preserves dispatcher timeout context with retry-once hint", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError("/tabs", {
      contains: ["Chrome CDP handshake timeout", "openclaw browser doctor", ...retryOnce],
      omits: ["Can't reach the OpenClaw browser control service", noRetry],
    });
  });

  it("avoids restart-gateway guidance for existing-session dispatcher timeouts", async () => {
    profileConfig("user", {
      driver: "existing-session",
      attachOnly: true,
    });
    mocks.dispatch.mockRejectedValueOnce(new DOMException("operation aborted", "AbortError"));

    await expectThrownBrowserFetchError("/tabs", {
      contains: ["operation aborted", ...externalProfile],
      omits: [noRestart, noRetry],
    });
  });

  it("avoids restart-gateway guidance for remote CDP dispatcher timeouts", async () => {
    profileConfig("remote", {
      cdpUrl: "https://browserless.example/chrome?token=test",
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("timed out"));

    await expectThrownBrowserFetchError("/tabs?profile=remote", {
      contains: ["timed out", ...externalProfile, ...retryOnce],
      omits: [noRestart, noRetry],
    });
  });

  it("suggests browser diagnostics when dispatcher profile resolution fails", async () => {
    mocks.loadConfig.mockImplementation(() => {
      throw new Error("config unavailable");
    });
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError("/tabs?profile=manual", {
      contains: ["Chrome CDP handshake timeout", "openclaw browser doctor", ...retryOnce],
      omits: [external, noRetry],
    });
  });

  it("keeps no-retry hint but not restart guidance for persistent external profile failures", async () => {
    profileConfig("manual", { cdpUrl: "http://127.0.0.1:9222", attachOnly: true }, true);
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP connection refused"));

    await expectThrownBrowserFetchError("/tabs?profile=manual", {
      contains: ["Chrome CDP connection refused", external, noRetry],
      omits: [noRestart],
    });
  });

  it("preserves validated structured errors from dispatcher routes", async () => {
    const details = {
      profile: "openclaw",
      requestedHeadless: false,
      headlessSource: "request",
      displayPresent: false,
    };
    dispatchError(409, {
      error: "display required",
      reason: "no_display_for_headed_profile",
      details,
    });

    const error = await fetchBrowserJson("/start?headless=false", { method: "POST" }).catch(
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "display required",
      reason: "no_display_for_headed_profile",
      details,
    });
  });

  it("keeps Browserbase-specific wording for Browserbase 429 responses", async () => {
    stubHttpError("max concurrent sessions exceeded", 429);

    await expectThrownBrowserFetchError("https://connect.browserbase.com/session", {
      contains: ["Browserbase rate limit reached", "upgrade your plan"],
      omits: ["max concurrent sessions exceeded"],
    });
  });

  it("non-429 errors still produce generic messages", async () => {
    stubHttpError("internal error", 500);

    await expectThrownBrowserFetchError("http://127.0.0.1:18888/", {
      contains: ["internal error"],
      omits: ["rate limit", retry, noRetry],
    });
  });

  it("uses operation metadata rather than timeout wording over HTTP", async () => {
    const body = {
      error: "locator.fill: Timeout 700ms exceeded: element is not editable",
      code: "ACT_OPERATION_FAILED",
    };
    stubHttpError(body, 500);
    const error = await expectThrownBrowserFetchError("http://127.0.0.1:18888/act", {
      contains: [body.error],
      omits: ["Retry the browser tool", "browser is currently unavailable", "Restart"],
    });
    expect(error).toMatchObject({ name: "BrowserServiceError", code: body.code, status: 500 });
  });

  it("keeps authentication failure advice even with operation metadata", async () => {
    dispatchError(401, { error: "Unauthorized", code: "ACT_OPERATION_FAILED" });
    await expectThrownBrowserFetchError("/act", {
      contains: ["Unauthorized", noRetry],
      omits: [retry],
    });
  });

  it("keeps pre-annotated persistent payload hints mutually exclusive", async () => {
    const persistentHint =
      "Do NOT retry the browser tool — it will keep failing. Use an alternative approach or inform the user that the browser is currently unavailable.";
    stubHttpError({ error: `browser request timed out. ${persistentHint}` }, 504);

    await expectThrownBrowserFetchError("http://127.0.0.1:18888/", {
      contains: ["browser request timed out", persistentHint],
      omits: [retry],
    });
  });

  it("keeps transient dispatcher error payloads retryable once", async () => {
    dispatchError(500, { error: "read ECONNRESET" });

    await expectThrownBrowserFetchError("/tabs", {
      contains: ["read ECONNRESET", ...retryOnce],
      omits: [noRetry],
    });
  });

  it("surfaces 429 from dispatcher path as rate-limit error", async () => {
    dispatchError(429, { error: "too many sessions" });

    await expectThrownBrowserFetchError("/tabs", {
      contains: ["Browser service rate limit reached", noRetry],
      omits: ["too many sessions"],
    });
  });

  it.each([
    {
      name: "nested reset cause",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      }),
      contains: ["fetch failed", ...retryOnce],
      omits: [noRetry],
    },
    {
      name: "nested refusal cause",
      error: new TypeError("browser request timed out", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      }),
      contains: ["browser request timed out", noRetry],
      omits: [retry],
    },
    {
      name: "non-finite timeout",
      error: new Error("timed out"),
      options: { timeoutMs: Number.NaN },
      contains: ["timed out after 5000ms", ...retryOnce],
      omits: ["NaNms", noRetry],
    },
    {
      name: "HTTP abort",
      error: new DOMException("operation aborted", "AbortError"),
      contains: ["Browser control request was cancelled"],
      omits: [noRetry],
    },
  ])(
    "classifies $name without conflicting retry advice",
    async ({ error, contains, omits, options }) => {
      stubFetchFailure(error);
      await expectThrownBrowserFetchError("http://example.com/", { contains, omits }, options);
    },
  );
});
