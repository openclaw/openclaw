import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const ATTACHED_HEALTH = {
  level: "high" as const,
  attached: true,
  mcpPid: 4321,
  port: null,
  browserUuid: null,
  reasons: ["cache:mcp-session-ready"],
  emptyState: false,
  cacheAttached: true,
};
const UNATTACHED_HEALTH = {
  level: "low" as const,
  attached: false,
  mcpPid: null,
  port: null,
  browserUuid: null,
  reasons: ["file:user-enabled-false"],
  emptyState: true,
  cacheAttached: false,
};

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
  probeChromeMcpHealth: vi.fn(async () => ATTACHED_HEALTH),
}));

const { probeChromeMcpHealth: probeChromeMcpHealthMock } = await import("../chrome-mcp.js");

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: {
  isHttpReachable?: () => Promise<boolean>;
  isTransportAvailable?: () => Promise<boolean>;
  isReachable?: () => Promise<boolean>;
}) {
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
        isTransportAvailable: params?.isTransportAvailable ?? (async () => true),
        isReachable: params?.isReachable ?? (async () => true),
      }) as never,
  };
}

function createManagedProfileState() {
  return {
    resolved: {
      enabled: true,
      headless: false,
      headlessSource: "default",
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: {
          name: "openclaw",
          driver: "openclaw",
          cdpPort: 18800,
          cdpUrl: "http://127.0.0.1:18800",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          userDataDir: "/tmp/openclaw-profile",
          color: "#FF4500",
          headless: false,
          headlessSource: "default",
          attachOnly: false,
        },
        isHttpReachable: async () => false,
        isTransportAvailable: async () => false,
        isReachable: async () => false,
      }) as never,
  };
}

async function callBasicRouteWithState(params: {
  query?: Record<string, string>;
  state: ReturnType<typeof createExistingSessionProfileState>;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => params.state,
    forProfile: params.state.forProfile,
  } as never);

  const handler = getHandlers.get("/");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? { profile: "chrome-live" } }, response.res);
  return response;
}

async function callStartRoute(params: {
  profile?: Record<string, unknown>;
  query?: Record<string, unknown>;
}) {
  const ensureBrowserAvailable = vi.fn(async () => {});
  const profile = {
    name: "openclaw",
    driver: "openclaw",
    cdpPort: 18800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    userDataDir: "/tmp/openclaw-profile",
    color: "#FF4500",
    headless: false,
    headlessSource: "default",
    attachOnly: false,
    ...params.profile,
  };
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

describe("basic browser routes", () => {
  it("reports Linux no-display headless fallback for local managed profiles", async () => {
    const originalPlatform = process.platform;
    const originalDisplay = process.env.DISPLAY;
    const originalWayland = process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const response = await callBasicRouteWithState({
        query: { profile: "openclaw" },
        state: createManagedProfileState(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        profile: "openclaw",
        headless: true,
        headlessSource: "linux-display-fallback",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalDisplay === undefined) {
        delete process.env.DISPLAY;
      } else {
        process.env.DISPLAY = originalDisplay;
      }
      if (originalWayland === undefined) {
        delete process.env.WAYLAND_DISPLAY;
      } else {
        process.env.WAYLAND_DISPLAY = originalWayland;
      }
    }
  });

  it("reports request-local headless source for tracked local launches", async () => {
    const state = createManagedProfileState();
    const profile = (state.forProfile() as { profile: unknown }).profile as never;
    state.profiles.set("openclaw", {
      profile,
      running: {
        pid: 222,
        exe: { kind: "chromium", path: "/usr/bin/chromium" },
        userDataDir: "/tmp/openclaw-profile",
        cdpPort: 18800,
        startedAt: Date.now(),
        proc: {} as never,
        headless: true,
        headlessSource: "request",
      },
    });

    const response = await callBasicRouteWithState({
      query: { profile: "openclaw" },
      state,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "openclaw",
      pid: 222,
      chosenBrowser: "chromium",
      headless: true,
      headlessSource: "request",
    });
  });

  it("maps existing-session status failures to JSON browser errors", async () => {
    vi.mocked(probeChromeMcpHealthMock).mockRejectedValueOnce(
      new BrowserProfileUnavailableError("attach failed"),
    );
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: "attach failed" });
  });

  it("reports Chrome MCP transport without fake CDP fields", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpPort: null,
      cdpUrl: null,
      userDataDir: "/tmp/brave-profile",
      executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      pid: 4321,
    });
  });

  it("passes valid start headless override to local managed profiles", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "true" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, profile: "openclaw" });
    expect(ensureBrowserAvailable).toHaveBeenCalledWith({
      headless: true,
      explicitStart: true,
    });
  });

  it("rejects invalid start headless values", async () => {
    const { response, ensureBrowserAvailable } = await callStartRoute({
      query: { headless: "maybe" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Invalid headless value. Use "true" or "false".',
    });
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
    expect(response.body).toMatchObject({
      error:
        'Headless start override is only supported for locally launched openclaw profiles. Profile "chrome-live" is attach-only, remote, or existing-session.',
    });
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
  });

  it("treats attach-only profiles as running when MCP cache is healthy even if page reachability is false", async () => {
    vi.mocked(probeChromeMcpHealthMock).mockResolvedValueOnce(ATTACHED_HEALTH);
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isReachable: async () => false,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpReady: true,
    });
  });

  it("uses the non-spawning Chrome MCP probe and skips reachability spawns for status", async () => {
    const isHttpReachable = vi.fn(async () => true);
    const isTransportAvailable = vi.fn(async () => true);
    vi.mocked(probeChromeMcpHealthMock).mockClear();
    vi.mocked(probeChromeMcpHealthMock).mockResolvedValueOnce(ATTACHED_HEALTH);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable,
        isTransportAvailable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(probeChromeMcpHealthMock).toHaveBeenCalledTimes(1);
    expect(isHttpReachable).not.toHaveBeenCalled();
    expect(isTransportAvailable).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      cdpHttp: true,
      cdpReady: true,
      running: true,
    });
  });

  it("reports not-running for chrome-mcp profile with empty session cache without spawning", async () => {
    const isHttpReachable = vi.fn(async () => true);
    const isTransportAvailable = vi.fn(async () => true);
    vi.mocked(probeChromeMcpHealthMock).mockResolvedValueOnce(UNATTACHED_HEALTH);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable,
        isTransportAvailable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(isHttpReachable).not.toHaveBeenCalled();
    expect(isTransportAvailable).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      transport: "chrome-mcp",
      running: false,
      cdpReady: false,
      cdpHttp: false,
      pid: null,
    });
  });
});
