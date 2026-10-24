import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import chromeExtensionManifest from "../../../chrome-extension/manifest.json" with { type: "json" };
import type { ProfileContext } from "../server-context.js";
import { makeBrowserProfile } from "../server-context.test-harness.js";
import { createRouteFixture } from "./request.test-support.js";

const graphics = vi.hoisted(() => ({ endpoint: vi.fn(), read: vi.fn() }));

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
  takeChromeMcpSnapshot: vi.fn(async () => ({})),
}));

vi.mock("../chrome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome.js")>()),
  getChromeWebSocketEndpoint: graphics.endpoint,
}));
vi.mock("../cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cdp.helpers.js")>()),
  withCdpSocket: graphics.read,
}));

const { ProfileRestartRequiredError } = await import("../server-context.lifecycle.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

type Reachability = (
  timeoutMs?: number,
  options?: { ephemeral?: boolean; signal?: AbortSignal },
) => Promise<boolean>;
type ProbeOptions = {
  ready?: boolean;
  isReachable?: Reachability;
  executablePath?: string;
};

function makeState(
  profileOverrides: Parameters<typeof makeBrowserProfile>[0] = {},
  options: ProbeOptions = {},
) {
  const profile = makeBrowserProfile({
    headless: true,
    headlessSource: "default",
    ...profileOverrides,
  });
  const ready = options.ready ?? false;
  const isReachable =
    options.isReachable ?? (async () => profile.driver === "existing-session" && ready);
  const isTransportAvailable: ProfileContext["isTransportAvailable"] = async (
    ms,
    signal,
    probe,
  ) => {
    if (ready && probe) {
      const pageReady = await isReachable(probe.timeoutMs?.() ?? ms, { ephemeral: true, signal });
      probe.onResult(pageReady ? 1 : null);
    }
    return ready;
  };
  return {
    resolved: {
      enabled: true,
      headless: profile.headless,
      noSandbox: false,
      executablePath: options.executablePath,
    },
    profiles: new Map(),
    forProfile: () => ({ profile, isHttpReachable: async () => ready, isTransportAvailable }),
  };
}

function existingState(options: ProbeOptions = {}) {
  return makeState(
    {
      name: "chrome-live",
      driver: "existing-session",
      cdpPort: 0,
      cdpUrl: "",
      headless: false,
      headlessSource: undefined,
      attachOnly: true,
    },
    { ready: true, ...options },
  );
}

async function callRoute(params: {
  route?: "/" | "/doctor" | "/start";
  query?: Record<string, unknown>;
  state: ReturnType<typeof makeState>;
  signal?: AbortSignal;
  forProfile?: () => unknown;
  expectedStatus?: number;
}) {
  const routes = createRouteFixture();
  registerBrowserBasicRoutes(routes.app, {
    state: () => params.state,
    forProfile: params.forProfile ?? params.state.forProfile,
  } as never);

  const response = await routes.request(
    params.route === "/start" ? "post" : "get",
    params.route ?? "/",
    {
      query: params.query ?? { profile: params.state.forProfile().profile.name },
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  expect(response.statusCode).toBe(params.expectedStatus ?? 200);
  return responseBodyRecord(response);
}

function trackLaunch(
  state: ReturnType<typeof makeState>,
  mode: { headless?: boolean; headlessSource?: string } = {},
) {
  state.profiles.set("openclaw", {
    running: {
      pid: 222,
      exe: { kind: "chromium" },
      cdpPort: 18800,
      ...mode,
    },
  });
}

async function callStartRoute(params: {
  profile?: Record<string, unknown>;
  query?: Record<string, unknown>;
  expectedStatus?: number;
}) {
  const ensureBrowserAvailable = vi.fn(async () => {});
  const state = makeState({ headless: false, ...params.profile });
  const body = await callRoute({
    state,
    route: "/start",
    query: params.query ?? {},
    expectedStatus: params.expectedStatus,
    forProfile: () => ({ profile: state.forProfile().profile, ensureBrowserAvailable }),
  });
  return { body, ensureBrowserAvailable };
}

function responseBodyRecord(response: { body: unknown }): Record<string, unknown> {
  if (!response.body || typeof response.body !== "object") {
    throw new Error("expected JSON response body");
  }
  return response.body as Record<string, unknown>;
}

describe("basic browser routes", () => {
  beforeEach(() => {
    graphics.endpoint.mockReset();
    graphics.read.mockReset();
  });

  it("reports version drift only from the selected extension profile owner", async () => {
    const outdatedVersion = chromeExtensionManifest.version === "2.0.0" ? "1.0.0" : "2.0.0";
    const state = {
      ...makeState({ name: "chrome", driver: "extension", attachOnly: true }, { ready: true }),
      extensionRelays: new Map([
        ["chrome", { bridge: { identity: { extensionVersion: outdatedVersion } } }],
        ["other", { bridge: { identity: { extensionVersion: chromeExtensionManifest.version } } }],
      ]),
    };

    const report = await callRoute({
      route: "/doctor",
      query: { profile: "chrome" },
      state,
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "extension-version",
        status: "warn",
        summary: expect.stringContaining(
          `running ${outdatedVersion}; bundled ${chromeExtensionManifest.version}`,
        ),
      }),
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
        url: "https://example.com",
      });
    const state = existingState();
    const profileCtx = {
      ...state.forProfile(),
      ensureBrowserAvailable,
      ensureTabAvailable,
    };
    await callRoute({
      state,
      forProfile: () => profileCtx,
      route: "/doctor",
      query: { profile: "chrome-live", deep: "true" },
    });
    expect(ensureBrowserAvailable).toHaveBeenCalledOnce();
    expect(ensureTabAvailable).toHaveBeenCalledTimes(2);
  });

  it("discovers registered engines and reports the selected lightpanda contract", async () => {
    const response = await callRoute({
      state: makeState({ engine: "lightpanda", attachOnly: true }),
    });
    expect(response).toMatchObject({
      engine: "lightpanda",
      sessionScope: "connection",
      screenshotFidelity: "none",
      availableEngines: [
        ["chromium", "managed-or-attach", "browser", "rendered"],
        ["lightpanda", "attach-only", "connection", "none"],
      ].map(([id, launchMode, sessionScope, screenshotFidelity]) => ({
        id,
        launchMode,
        sessionScope,
        screenshotFidelity,
      })),
    });
  });

  it.each([
    {
      name: "local profile",
      route: "/doctor",
      profile: { executablePath: process.execPath },
      executablePath: "/definitely-missing-global-chromium",
    },
    {
      name: "remote profile",
      route: "/",
      profile: {
        cdpHost: "remote.example",
        cdpIsLoopback: false,
        cdpUrl: "http://remote.example:9222",
        executablePath: "/definitely-missing-ignored-profile-chromium",
      },
      executablePath: process.execPath,
    },
  ] as const)(
    "detects the owning executable for $name",
    async ({ route, profile, executablePath }) => {
      const response = await callRoute({
        route,
        state: makeState(profile, { executablePath }),
      });
      expect(route === "/doctor" ? response.status : response).toMatchObject({
        executablePath: profile.executablePath,
        detectedBrowser: "custom",
        detectedExecutablePath: process.execPath,
        detectError: null,
      });
      if (route === "/doctor") {
        expect(response.ok).toBe(true);
      }
    },
  );

  it("reports request-local headless source for tracked local launches", async () => {
    const state = makeState({
      cdpUrl: "http://openclaw:relay-token@127.0.0.1:18800",
    });
    trackLaunch(state, { headless: true, headlessSource: "request" });

    const response = await callRoute({ state });

    expect(response).toMatchObject({
      profile: "openclaw",
      pid: 222,
      chosenBrowser: "chromium",
      cdpUrl: "http://127.0.0.1:18800",
      headless: true,
      headlessSource: "request",
      graphics: null,
    });
    expect(graphics.endpoint).not.toHaveBeenCalled();
  });

  it("retries unavailable graphics diagnostics and caches the first available result", async () => {
    const clock = vi.spyOn(Date, "now");
    onTestFinished(() => clock.mockRestore());
    const unavailable = {
      status: "unavailable",
      observedAt: 123,
      reason: "SystemInfo.getInfo timed out",
    } as const;
    const available = {
      status: "available",
      observedAt: 456,
      acceleration: "unknown",
      renderer: null,
      vendor: null,
      version: null,
      backend: null,
      devices: [],
      featureStatus: {},
      disabledFeatures: [],
      driverBugWorkarounds: [],
      videoDecoding: [],
      videoEncoding: [],
    } as const;
    graphics.endpoint.mockResolvedValue({ url: "ws://127.0.0.1:18800/devtools/browser" });
    graphics.read
      .mockRejectedValueOnce(new Error(unavailable.reason))
      .mockResolvedValue({ gpu: {} });
    const state = makeState({}, { ready: true });
    trackLaunch(state);

    for (const expected of [unavailable, available, available]) {
      clock.mockReturnValue(expected.observedAt);
      expect((await callRoute({ state })).graphics).toEqual(expected);
    }
    expect(graphics.read).toHaveBeenCalledTimes(2);
  });

  it("passes valid start headless override to local managed profiles", async () => {
    const { body, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "true" },
    });

    expect(body).toEqual({ ok: true, profile: "openclaw" });
    expect(ensureBrowserAvailable).toHaveBeenCalledWith({ headless: true });
  });

  it.each([
    {
      name: "invalid value",
      query: { headless: "maybe" },
      profile: undefined,
      error: 'Invalid headless value. Use "true" or "false".',
    },
    {
      name: "existing-session override",
      query: { headless: "true" },
      profile: { name: "chrome-live", driver: "existing-session", attachOnly: true },
      error:
        'Headless start override is only supported for locally launched openclaw profiles. Profile "chrome-live" is attach-only, remote, or existing-session.',
    },
  ])("rejects start $name", async ({ query, profile, error }) => {
    const { body, ensureBrowserAvailable } = await callStartRoute({
      query,
      profile,
      expectedStatus: 400,
    });
    expect(body.error).toBe(error);
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
  });

  it("cancels an in-flight Chrome MCP page-readiness probe", async () => {
    const controller = new AbortController();
    const cancellation = new Error("browser status cancelled");
    const isReachable = vi.fn<Reachability>(
      async (_timeoutMs, options) =>
        await new Promise<boolean>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(cancellation), {
            once: true,
          });
        }),
    );

    const pending = callRoute({
      state: existingState({ isReachable }),
      signal: controller.signal,
      expectedStatus: 500,
    });
    await vi.waitFor(() => expect(isReachable).toHaveBeenCalledOnce());
    controller.abort(cancellation);

    const response = await pending;
    expect(response.error).toBe("Error: browser status cancelled");
    const [, options] = expectDefined(isReachable.mock.calls[0], "reachability probe");
    expect(options?.signal).toMatchObject({ aborted: true, reason: cancellation });
  });
});
