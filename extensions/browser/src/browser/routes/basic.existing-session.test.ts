import { beforeEach, describe, expect, it, vi } from "vitest";
import chromeExtensionManifest from "../../../chrome-extension/manifest.json" with { type: "json" };
import { makeBrowserProfile } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const { inspectChromeGraphicsDiagnosticsMock } = vi.hoisted(() => ({
  inspectChromeGraphicsDiagnosticsMock: vi.fn(),
}));

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
  takeChromeMcpSnapshot: vi.fn(async () => ({})),
}));

vi.mock("../chrome.graphics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome.graphics.js")>()),
  inspectChromeGraphicsDiagnostics: inspectChromeGraphicsDiagnosticsMock,
}));

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { ProfileRestartRequiredError } = await import("../server-context.lifecycle.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function managedProfile(overrides: Record<string, unknown> = {}) {
  return makeBrowserProfile({
    userDataDir: "/tmp/openclaw-profile",
    headless: true,
    headlessSource: "default",
    ...overrides,
  });
}

function createExistingSessionProfileState(params?: {
  isHttpReachable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isTransportAvailable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isReachable?: (
    timeoutMs?: number,
    options?: { ephemeral?: boolean; signal?: AbortSignal },
  ) => Promise<boolean>;
}) {
  const isTransportAvailable = params?.isTransportAvailable ?? (async () => true);
  const isReachable = params?.isReachable ?? (async () => true);
  return {
    resolved: {
      enabled: true,
      headless: false,
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: {
          name: "chrome-live",
          driver: "existing-session",
          cdpPort: 0,
          cdpUrl: "",
          userDataDir: "/tmp/brave-profile",
          color: "#00AA00",
          executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          headless: false,
          attachOnly: true,
        },
        isHttpReachable: params?.isHttpReachable ?? (async () => true),
        isTransportAvailable: async (
          timeoutMs?: number,
          signal?: AbortSignal,
          pageProbe?: { timeoutMs?: () => number; onResult: (tabCount: number | null) => void },
        ) => {
          const available = await isTransportAvailable(timeoutMs, signal);
          if (available && pageProbe) {
            try {
              const ready = await isReachable(pageProbe.timeoutMs?.() ?? timeoutMs, {
                ephemeral: true,
                signal,
              });
              pageProbe.onResult(ready ? 1 : null);
            } catch {
              signal?.throwIfAborted();
              pageProbe.onResult(null);
            }
          }
          return available;
        },
        isReachable,
      }) as never,
  };
}

function readFirstReachabilityCall(
  isReachable: ReturnType<typeof vi.fn>,
): [number | undefined, { ephemeral?: boolean; signal?: AbortSignal } | undefined] {
  const [call] = isReachable.mock.calls as Array<
    [number | undefined, { ephemeral?: boolean; signal?: AbortSignal } | undefined]
  >;
  if (!call) {
    throw new Error("expected reachability probe call");
  }
  return call;
}

function createManagedProfileState(
  profileOverrides?: Record<string, unknown>,
  reachability?: {
    isHttpReachable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
    isTransportAvailable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  },
  executablePath?: string,
) {
  return {
    resolved: {
      enabled: true,
      headless: true,
      headlessSource: "default",
      noSandbox: false,
      executablePath,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: managedProfile(profileOverrides),
        isHttpReachable: reachability?.isHttpReachable ?? (async () => false),
        isTransportAvailable: reachability?.isTransportAvailable ?? (async () => false),
        isReachable: async () => false,
      }) as never,
  };
}

async function callBasicRouteWithState(params: {
  route?: "/" | "/doctor";
  query?: Record<string, string>;
  state: ReturnType<typeof createExistingSessionProfileState | typeof createManagedProfileState>;
  signal?: AbortSignal;
  forProfile?: () => unknown;
  expectedStatus?: number;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => params.state,
    forProfile: params.forProfile ?? params.state.forProfile,
  } as never);

  const handler = getHandlers.get(params.route ?? "/");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: {},
      query: params.query ?? { profile: "chrome-live" },
      ...(params.signal ? { signal: params.signal } : {}),
    },
    response.res,
  );
  expect(response.statusCode).toBe(params.expectedStatus ?? 200);
  return responseBodyRecord(response);
}

function trackLaunch(
  state: ReturnType<typeof createManagedProfileState>,
  mode: { headless?: boolean; headlessSource?: string } = {},
) {
  const profile = (state.forProfile() as { profile: unknown }).profile as never;
  state.profiles.set("openclaw", {
    profile,
    running: {
      pid: 222,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: "/tmp/openclaw-profile",
      cdpPort: 18800,
      proc: {} as never,
      ...mode,
    },
  });
}

async function callStartRoute(params: {
  profile?: Record<string, unknown>;
  query?: Record<string, unknown>;
  error?: Error;
}) {
  const ensureBrowserAvailable = vi.fn(async () => {
    if (params.error) {
      throw params.error;
    }
  });
  const profile = managedProfile({ headless: false, ...params.profile });
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => ({ resolved: { enabled: true, headless: false }, profiles: new Map() }),
    forProfile: () =>
      ({
        profile,
        ensureBrowserAvailable,
      }) as never,
  } as never);

  const handler = postHandlers.get("/start");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? {} }, response.res);
  return { response, ensureBrowserAvailable };
}

function responseBodyRecord(response: { body: unknown }): Record<string, unknown> {
  if (!response.body || typeof response.body !== "object") {
    throw new Error("expected JSON response body");
  }
  return response.body as Record<string, unknown>;
}

describe("basic browser routes", () => {
  beforeEach(() => {
    inspectChromeGraphicsDiagnosticsMock.mockReset();
  });

  it("reports version drift only from the selected extension profile owner", async () => {
    const outdatedVersion = chromeExtensionManifest.version === "2.0.0" ? "1.0.0" : "2.0.0";
    const state = {
      ...createManagedProfileState(
        { name: "chrome", driver: "extension", attachOnly: true },
        {
          isHttpReachable: async () => true,
          isTransportAvailable: async () => true,
        },
      ),
      extensionRelays: new Map([
        ["chrome", { bridge: { identity: { extensionVersion: outdatedVersion } } }],
        ["other", { bridge: { identity: { extensionVersion: chromeExtensionManifest.version } } }],
      ]),
    };

    const report = await callBasicRouteWithState({
      route: "/doctor",
      query: { profile: "chrome" },
      state,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "extension-version",
          status: "warn",
          summary: expect.stringContaining(
            `running ${outdatedVersion}; bundled ${chromeExtensionManifest.version}`,
          ),
        }),
      ]),
    );
    expect(report.status).not.toHaveProperty("chromeExtension");
  });

  it("releases the doctor transaction, restarts once, and retries the live probe", async () => {
    const ensureBrowserAvailable = vi.fn(async () => {});
    const ensureTabAvailable = vi
      .fn()
      .mockRejectedValueOnce(new ProfileRestartRequiredError())
      .mockResolvedValueOnce({
        targetId: "7",
        title: "",
        url: "https://example.com",
        type: "page",
      });
    const state = createExistingSessionProfileState();
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureBrowserAvailable,
      ensureTabAvailable,
    };
    await callBasicRouteWithState({
      state,
      forProfile: () => profileCtx,
      route: "/doctor",
      query: { profile: "chrome-live", deep: "true" },
    });
    expect(ensureBrowserAvailable).toHaveBeenCalledOnce();
    expect(ensureTabAvailable).toHaveBeenCalledTimes(2);
  });

  it("discovers registered engines and reports the selected lightpanda contract", async () => {
    const response = await callBasicRouteWithState({
      state: createManagedProfileState({ engine: "lightpanda", attachOnly: true }),
    });
    expect(response).toMatchObject({
      engine: "lightpanda",
      sessionScope: "connection",
      screenshotFidelity: "none",
      availableEngines: [
        {
          id: "chromium",
          launchMode: "managed-or-attach",
          sessionScope: "browser",
          screenshotFidelity: "rendered",
        },
        {
          id: "lightpanda",
          launchMode: "attach-only",
          sessionScope: "connection",
          screenshotFidelity: "none",
        },
      ],
    });
  });

  it("detects the local managed profile executable for /doctor", async () => {
    const response = await callBasicRouteWithState({
      route: "/doctor",
      query: { profile: "openclaw" },
      state: createManagedProfileState(
        { executablePath: process.execPath, headless: true },
        undefined,
        "/definitely-missing-global-chromium",
      ),
    });

    const browserStatus = responseBodyRecord({ body: response.status });
    expect(browserStatus).toMatchObject({
      executablePath: process.execPath,
      detectedBrowser: "custom",
      detectedExecutablePath: process.execPath,
      detectError: null,
    });
    expect(response.ok).toBe(true);
  });

  it("ignores a non-owning remote CDP profile executable override", async () => {
    const ignoredExecutable = "/definitely-missing-ignored-profile-chromium";
    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state: createManagedProfileState(
        {
          cdpHost: "remote.example",
          cdpIsLoopback: false,
          cdpUrl: "http://remote.example:9222",
          executablePath: ignoredExecutable,
          headless: true,
        },
        undefined,
        process.execPath,
      ),
    });

    expect(response).toMatchObject({
      executablePath: ignoredExecutable,
      detectedBrowser: "custom",
      detectedExecutablePath: process.execPath,
      detectError: null,
    });
  });

  it("reports request-local headless source for tracked local launches", async () => {
    const state = createManagedProfileState({
      cdpUrl: "http://openclaw:relay-token@127.0.0.1:18800",
    });
    trackLaunch(state, { headless: true, headlessSource: "request" });

    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state,
    });

    expect(response).toMatchObject({
      profile: "openclaw",
      pid: 222,
      chosenBrowser: "chromium",
      cdpUrl: "http://127.0.0.1:18800",
      headless: true,
      headlessSource: "request",
      graphics: null,
    });
    expect(inspectChromeGraphicsDiagnosticsMock).not.toHaveBeenCalled();
  });

  it("retries unavailable graphics diagnostics and caches the first available result", async () => {
    const unavailable = {
      status: "unavailable",
      observedAt: 123,
      reason: "SystemInfo.getInfo timed out",
    } as const;
    const available = {
      status: "available",
      observedAt: 456,
      acceleration: "hardware",
      renderer: "ANGLE (Intel)",
      vendor: "Intel",
      version: "OpenGL ES 3.0",
      backend: "(gl=angle,angle=metal)",
      devices: [],
      featureStatus: { webgl: "enabled" },
      disabledFeatures: [],
      driverBugWorkarounds: [],
      videoDecoding: [],
      videoEncoding: [],
    } as const;
    inspectChromeGraphicsDiagnosticsMock
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(available);
    const state = createManagedProfileState(
      {},
      {
        isHttpReachable: async () => true,
        isTransportAvailable: async () => true,
      },
    );
    trackLaunch(state);

    const first = await callBasicRouteWithState({ query: { profile: "openclaw" }, state });
    const second = await callBasicRouteWithState({ query: { profile: "openclaw" }, state });
    const third = await callBasicRouteWithState({ query: { profile: "openclaw" }, state });

    expect(first.graphics).toEqual(unavailable);
    expect(second.graphics).toEqual(available);
    expect(third.graphics).toEqual(available);
    expect(inspectChromeGraphicsDiagnosticsMock).toHaveBeenCalledTimes(2);
  });

  it("passes valid start headless override to local managed profiles", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "true" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, profile: "openclaw" });
    expect(ensureBrowserAvailable).toHaveBeenCalledWith({ headless: true });
  });

  it("returns structured no-display metadata without replacing the error message", async () => {
    const metadata = {
      reason: "no_display_for_headed_profile",
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "profile",
        displayPresent: false,
      },
    };
    const { response } = await callStartRoute({
      error: new BrowserProfileUnavailableError("display required", { metadata }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "display required",
      ...metadata,
    });
  });

  it("rejects invalid start headless values", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "maybe" },
    });

    expect(response.statusCode).toBe(400);
    expect(responseBodyRecord(response).error).toBe(
      'Invalid headless value. Use "true" or "false".',
    );
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
  });

  it("rejects start headless override for existing-session profiles", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      profile: {
        name: "chrome-live",
        driver: "existing-session",
        cdpPort: 0,
        cdpUrl: "",
        cdpHost: "",
        cdpIsLoopback: true,
        attachOnly: true,
      },
      query: { headless: "true" },
    });

    expect(response.statusCode).toBe(400);
    expect(responseBodyRecord(response).error).toBe(
      'Headless start override is only supported for locally launched openclaw profiles. Profile "chrome-live" is attach-only, remote, or existing-session.',
    );
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
  });

  it("reports pageReady=false when Chrome MCP transport is up but page tools are unreachable", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable: async () => false,
      }),
    });

    expect(response).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpReady: true,
      pageReady: false,
    });
  });

  it("cancels an in-flight Chrome MCP page-readiness probe", async () => {
    const controller = new AbortController();
    const cancellation = new Error("browser status cancelled");
    const isReachable = vi.fn(
      async (_timeoutMs?: number, options?: { ephemeral?: boolean; signal?: AbortSignal }) =>
        await new Promise<boolean>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(cancellation), {
            once: true,
          });
        }),
    );

    const pending = callBasicRouteWithState({
      state: createExistingSessionProfileState({ isReachable }),
      signal: controller.signal,
      expectedStatus: 500,
    });
    await vi.waitFor(() => expect(isReachable).toHaveBeenCalledOnce());
    controller.abort(cancellation);

    const response = await pending;
    expect(response.error).toBe("Error: browser status cancelled");
    const [, options] = readFirstReachabilityCall(isReachable);
    expect(options?.signal?.aborted).toBe(true);
    expect(options?.signal?.reason).toBe(cancellation);
  });

  it("keeps Chrome MCP page-readiness inside the status budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const isReachable = vi.fn(async () => true);
    try {
      const response = await callBasicRouteWithState({
        state: createExistingSessionProfileState({
          isTransportAvailable: async () => {
            vi.setSystemTime(4_000);
            return true;
          },
          isReachable,
        }),
      });

      const [timeoutMs, reachabilityOptions] = readFirstReachabilityCall(isReachable);
      expect(timeoutMs).toBe(4_000);
      expect(response).toMatchObject({
        cdpHttp: true,
        cdpReady: true,
        pageReady: true,
        running: true,
      });
      expect(reachabilityOptions?.ephemeral).toBe(true);
      expect(reachabilityOptions?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });
});
