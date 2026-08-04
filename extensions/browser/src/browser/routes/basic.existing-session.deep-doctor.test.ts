// Browser tests cover basic.existing session plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const {
  captureAriaSnapshotViaPlaywrightMock,
  getPwAiModuleMock,
  inspectChromeGraphicsDiagnosticsMock,
  takeChromeMcpSnapshotMock,
} = vi.hoisted(() => {
  const captureAriaSnapshotMock = vi.fn();
  return {
    captureAriaSnapshotViaPlaywrightMock: captureAriaSnapshotMock,
    getPwAiModuleMock: vi.fn(async () => ({
      captureAriaSnapshotViaPlaywright: captureAriaSnapshotViaPlaywrightMock,
    })),
    inspectChromeGraphicsDiagnosticsMock: vi.fn(),
    takeChromeMcpSnapshotMock: vi.fn(async () => ({})),
  };
});

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: getPwAiModuleMock,
}));

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
  takeChromeMcpSnapshot: takeChromeMcpSnapshotMock,
}));

vi.mock("../chrome.graphics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chrome.graphics.js")>();
  return {
    ...actual,
    inspectChromeGraphicsDiagnostics: inspectChromeGraphicsDiagnosticsMock,
  };
});

const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: {
  isHttpReachable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isTransportAvailable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isReachable?: (
    timeoutMs?: number,
    options?: { ephemeral?: boolean; signal?: AbortSignal },
  ) => Promise<boolean>;
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

function createManagedProfileState(
  profileOverrides?: Record<string, unknown>,
  reachability?: {
    isHttpReachable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
    isTransportAvailable?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  },
) {
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
          ...profileOverrides,
        },
        isHttpReachable: reachability?.isHttpReachable ?? (async () => false),
        isTransportAvailable: reachability?.isTransportAvailable ?? (async () => false),
        isReachable: async () => false,
      }) as never,
  };
}

function responseBodyRecord(response: { body: unknown }): Record<string, unknown> {
  if (!response.body || typeof response.body !== "object") {
    throw new Error("expected JSON response body");
  }
  return response.body as Record<string, unknown>;
}

describe("basic browser deep-doctor routes", () => {
  beforeEach(() => {
    captureAriaSnapshotViaPlaywrightMock.mockReset();
    getPwAiModuleMock.mockReset();
    getPwAiModuleMock.mockResolvedValue({
      captureAriaSnapshotViaPlaywright: captureAriaSnapshotViaPlaywrightMock,
    });
    inspectChromeGraphicsDiagnosticsMock.mockReset();
    takeChromeMcpSnapshotMock.mockClear();
  });

  it("bounds Chrome MCP deep-doctor snapshots with the live-probe timeout", async () => {
    const state = createExistingSessionProfileState();
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureTabAvailable: vi.fn(async () => ({
        targetId: "7",
        title: "Example",
        url: "https://example.com",
        type: "page",
      })),
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "chrome-live", deep: "true" } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(takeChromeMcpSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "chrome-live",
        targetId: "7",
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
    const snapshotCall = takeChromeMcpSnapshotMock.mock.calls[0] as unknown as
      | [{ timeoutMs: number }]
      | undefined;
    const snapshotTimeoutMs = snapshotCall?.[0].timeoutMs;
    expect(snapshotTimeoutMs).toBeGreaterThan(0);
    expect(snapshotTimeoutMs).toBeLessThanOrEqual(12_000);
  });

  it("shares one live-probe deadline across tab selection and the Chrome MCP snapshot", async () => {
    vi.useFakeTimers();
    try {
      takeChromeMcpSnapshotMock.mockImplementationOnce(async (...args: unknown[]) => {
        const options = args[0] as { signal?: AbortSignal } | undefined;
        return await new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () =>
            reject(
              options?.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error(String(options?.signal?.reason ?? "snapshot aborted")),
            );
          if (options?.signal?.aborted) {
            rejectOnAbort();
            return;
          }
          options?.signal?.addEventListener("abort", rejectOnAbort, { once: true });
        });
      });
      const state = createExistingSessionProfileState();
      const profileCtx = {
        ...(state.forProfile() as unknown as Record<string, unknown>),
        ensureTabAvailable: vi.fn(
          async (_targetId: string | undefined, options?: { signal?: AbortSignal }) => {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 2_000);
              options?.signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(
                    options.signal?.reason instanceof Error
                      ? options.signal.reason
                      : new Error(String(options.signal?.reason ?? "snapshot aborted")),
                  );
                },
                { once: true },
              );
            });
            return {
              targetId: "7",
              title: "Example",
              url: "https://example.com",
              type: "page",
            };
          },
        ),
      };
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, {
        state: () => state,
        forProfile: () => profileCtx,
        mapTabError: vi.fn(() => null),
      } as never);
      const response = createBrowserRouteResponse();

      const startedAtMs = Date.now();
      const request = getHandlers.get("/doctor")?.(
        { params: {}, query: { profile: "chrome-live", deep: "true" } },
        response.res,
      );
      let settled = false;
      void request?.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(takeChromeMcpSnapshotMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await request;

      expect(Date.now() - startedAtMs).toBe(12_000);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ ok: false });
      expect((response.body as { checks?: unknown[] }).checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "live-snapshot",
            status: "fail",
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves Playwright target and method context at the live-probe deadline", async () => {
    vi.useFakeTimers();
    try {
      captureAriaSnapshotViaPlaywrightMock.mockImplementationOnce(
        async (options: { signal?: AbortSignal; targetId?: string; timeoutMs?: number }) =>
          await new Promise<never>((_resolve, reject) => {
            const timeoutMs = options.timeoutMs ?? 12_000;
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Aria snapshot via Playwright timed out after ${timeoutMs}ms ` +
                      `(targetId=${options.targetId ?? "current"}, method=Accessibility.enable).`,
                  ),
                ),
              timeoutMs,
            );
            options.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(
                  options.signal?.reason instanceof Error
                    ? options.signal.reason
                    : new Error(String(options.signal?.reason ?? "snapshot aborted")),
                );
              },
              { once: true },
            );
          }),
      );
      const state = createManagedProfileState(
        {
          name: "chrome",
          driver: "extension",
          cdpPort: 31002,
          cdpUrl: "http://127.0.0.1:31002",
          attachOnly: true,
        },
        {
          isHttpReachable: async () => true,
          isTransportAvailable: async () => true,
        },
      );
      const profileCtx = {
        ...(state.forProfile() as unknown as Record<string, unknown>),
        ensureTabAvailable: vi.fn(async () => ({
          targetId: "extension-target-1",
          title: "Example",
          url: "https://example.com",
          type: "page",
        })),
      };
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, {
        state: () => state,
        forProfile: () => profileCtx,
        mapTabError: vi.fn(() => null),
      } as never);
      const response = createBrowserRouteResponse();

      const request = getHandlers.get("/doctor")?.(
        { params: {}, query: { profile: "chrome", deep: "true" } },
        response.res,
      );
      await vi.advanceTimersByTimeAsync(12_000);
      await request;

      const checks = responseBodyRecord(response).checks as Array<{
        id?: string;
        summary?: string;
        fixHint?: string;
      }>;
      const liveSnapshot = checks.find((check) => check.id === "live-snapshot");
      expect(liveSnapshot?.summary).toContain(
        "targetId=extension-target-1, method=Accessibility.enable",
      );
      expect(liveSnapshot?.fixHint).toContain("Reload the shared Chrome tab");
      expect(liveSnapshot?.fixHint).toContain(
        "openclaw browser --browser-profile chrome doctor --deep",
      );
      expect(liveSnapshot?.fixHint).not.toContain("browser start");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives attach-only live probe failures attach recovery guidance", async () => {
    const state = createManagedProfileState(
      { name: "attached", attachOnly: true },
      { isHttpReachable: async () => true, isTransportAvailable: async () => true },
    );
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureTabAvailable: vi.fn(async () => {
        throw new Error("renderer stalled");
      }),
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "attached", deep: "true" } },
      response.res,
    );

    const checks = responseBodyRecord(response).checks as Array<{
      id?: string;
      fixHint?: string;
    }>;
    const liveSnapshot = checks.find((check) => check.id === "live-snapshot");
    expect(liveSnapshot?.fixHint).toContain("externally managed Chromium target");
    expect(liveSnapshot?.fixHint).toContain(
      "openclaw browser --browser-profile attached doctor --deep",
    );
    expect(liveSnapshot?.fixHint).not.toContain("browser start");
  });

  it("does not suggest browser start for a running managed browser", async () => {
    const state = createManagedProfileState(
      {},
      { isHttpReachable: async () => true, isTransportAvailable: async () => true },
    );
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureTabAvailable: vi.fn(async () => {
        throw new Error("renderer stalled");
      }),
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "openclaw", deep: "true" } },
      response.res,
    );

    const checks = responseBodyRecord(response).checks as Array<{
      id?: string;
      fixHint?: string;
    }>;
    const liveSnapshot = checks.find((check) => check.id === "live-snapshot");
    expect(liveSnapshot?.fixHint).toContain("Reload the stalled page");
    expect(liveSnapshot?.fixHint).not.toMatch(/Run openclaw browser start/i);
  });

  it("still probes an extension profile after the short status check misses", async () => {
    captureAriaSnapshotViaPlaywrightMock.mockResolvedValueOnce({
      nodes: [{ ref: "ax1", role: "document", name: "Example" }],
    });
    const state = createManagedProfileState(
      {
        name: "chrome",
        driver: "extension",
        cdpPort: 31002,
        cdpUrl: "http://127.0.0.1:31002",
        attachOnly: true,
      },
      {
        isHttpReachable: async () => false,
        isTransportAvailable: async () => false,
      },
    );
    const ensureTabAvailable = vi.fn(async () => ({
      targetId: "extension-target-1",
      title: "Example",
      url: "https://example.com",
      type: "page",
    }));
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureTabAvailable,
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "chrome", deep: "true" } },
      response.res,
    );

    expect(ensureTabAvailable).toHaveBeenCalledOnce();
    expect(captureAriaSnapshotViaPlaywrightMock).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      status: { running: true, cdpReady: true, pageReady: true },
    });
    const checks = responseBodyRecord(response).checks as Array<{
      id?: string;
      status?: string;
      summary?: string;
    }>;
    expect(response.body).toMatchObject({ ok: true });
    expect(response.body).toMatchObject({
      status: { running: true, cdpReady: true, pageReady: true },
    });
    expect(checks.find((check) => check.id === "extension-relay")).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("validated by the live snapshot probe"),
    });
    expect(checks.find((check) => check.id === "live-snapshot")).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("extension-target-1"),
    });
  });

  it("reconciles a stale Chrome MCP attach failure after the live probe succeeds", async () => {
    const state = createExistingSessionProfileState({
      isHttpReachable: async () => false,
      isTransportAvailable: async () => false,
      isReachable: async () => false,
    });
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureTabAvailable: vi.fn(async () => ({
        targetId: "7",
        title: "Example",
        url: "https://example.com",
        type: "page",
      })),
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "chrome-live", deep: "true" } },
      response.res,
    );

    const body = responseBodyRecord(response);
    const checks = body.checks as Array<{ id?: string; status?: string; summary?: string }>;
    expect(body.ok).toBe(true);
    expect(body.status).toMatchObject({ running: true, cdpReady: true, pageReady: true });
    expect(checks.find((check) => check.id === "attach-target")).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("validated by the live snapshot probe"),
    });
    expect(checks.find((check) => check.id === "live-snapshot")).toMatchObject({
      status: "pass",
    });
  });

  it("still probes a loopback attach-only profile after the short status check misses", async () => {
    captureAriaSnapshotViaPlaywrightMock.mockResolvedValueOnce({
      nodes: [{ ref: "ax1", role: "document", name: "Example" }],
    });
    const state = createManagedProfileState(
      { name: "attached", attachOnly: true },
      {
        isHttpReachable: async () => false,
        isTransportAvailable: async () => false,
      },
    );
    const ensureTabAvailable = vi.fn(async () => ({
      targetId: "attached-target-1",
      title: "Example",
      url: "https://example.com",
      type: "page",
    }));
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureTabAvailable,
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "attached", deep: "true" } },
      response.res,
    );

    expect(ensureTabAvailable).toHaveBeenCalledOnce();
    expect(captureAriaSnapshotViaPlaywrightMock).toHaveBeenCalledOnce();
    const checks = responseBodyRecord(response).checks as Array<{
      id?: string;
      status?: string;
      summary?: string;
    }>;
    expect(checks.find((check) => check.id === "live-snapshot")).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("attached-target-1"),
    });
    expect(checks.find((check) => check.id === "cdp-websocket")).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("validated by the live snapshot probe"),
    });
  });

  it("charges lazy Playwright loading to the absolute live-probe deadline", async () => {
    vi.useFakeTimers();
    try {
      getPwAiModuleMock.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        });
        return { captureAriaSnapshotViaPlaywright: captureAriaSnapshotViaPlaywrightMock };
      });
      captureAriaSnapshotViaPlaywrightMock.mockImplementationOnce(
        async (options: { timeoutMs?: number }) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, options.timeoutMs);
          });
          throw new Error(`contextual capture timeout after ${options.timeoutMs}ms`);
        },
      );
      const state = createManagedProfileState(
        {
          name: "chrome",
          driver: "extension",
          cdpPort: 31002,
          cdpUrl: "http://127.0.0.1:31002",
          attachOnly: true,
        },
        {
          isHttpReachable: async () => true,
          isTransportAvailable: async () => true,
        },
      );
      const profileCtx = {
        ...(state.forProfile() as unknown as Record<string, unknown>),
        ensureTabAvailable: vi.fn(async () => ({
          targetId: "extension-target-1",
          title: "Example",
          url: "https://example.com",
          type: "page",
        })),
      };
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, {
        state: () => state,
        forProfile: () => profileCtx,
        mapTabError: vi.fn(() => null),
      } as never);
      const response = createBrowserRouteResponse();

      const startedAtMs = Date.now();
      const request = getHandlers.get("/doctor")?.(
        { params: {}, query: { profile: "chrome", deep: "true" } },
        response.res,
      );
      await vi.advanceTimersByTimeAsync(2_000);

      expect(captureAriaSnapshotViaPlaywrightMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await request;

      expect(Date.now() - startedAtMs).toBe(12_000);
      const checks = responseBodyRecord(response).checks as Array<{
        id?: string;
        summary?: string;
      }>;
      expect(checks.find((check) => check.id === "live-snapshot")?.summary).toContain(
        "contextual capture timeout after 10000ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at the absolute live-probe deadline when lazy Playwright loading stalls", async () => {
    vi.useFakeTimers();
    try {
      getPwAiModuleMock.mockImplementationOnce(async () => await new Promise<never>(() => {}));
      const state = createManagedProfileState(
        {
          name: "chrome",
          driver: "extension",
          cdpPort: 31002,
          cdpUrl: "http://127.0.0.1:31002",
          attachOnly: true,
        },
        {
          isHttpReachable: async () => true,
          isTransportAvailable: async () => true,
        },
      );
      const ensureTabAvailable = vi.fn(async () => ({
        targetId: "extension-target-1",
        title: "Example",
        url: "https://example.com",
        type: "page",
      }));
      const profileCtx = {
        ...(state.forProfile() as unknown as Record<string, unknown>),
        ensureTabAvailable,
      };
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, {
        state: () => state,
        forProfile: () => profileCtx,
        mapTabError: vi.fn(() => null),
      } as never);
      const response = createBrowserRouteResponse();

      const request = getHandlers.get("/doctor")?.(
        { params: {}, query: { profile: "chrome", deep: "true" } },
        response.res,
      );
      await vi.advanceTimersByTimeAsync(12_000);
      await request;

      expect(ensureTabAvailable).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ createIfMissing: false, signal: expect.any(AbortSignal) }),
      );
      expect(captureAriaSnapshotViaPlaywrightMock).not.toHaveBeenCalled();
      const checks = responseBodyRecord(response).checks as Array<{
        id?: string;
        status?: string;
        summary?: string;
      }>;
      expect(checks.find((check) => check.id === "live-snapshot")).toMatchObject({
        status: "fail",
        summary: expect.stringContaining("Live snapshot probe timed out after 12000ms"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a stopped managed browser for deep doctor", async () => {
    const ensureBrowserAvailable = vi.fn(async () => {});
    const ensureTabAvailable = vi.fn(async () => {
      throw new Error("deep doctor must not create a tab while stopped");
    });
    const state = createManagedProfileState({ name: "work profile" });
    const profileCtx = {
      ...(state.forProfile() as unknown as Record<string, unknown>),
      ensureBrowserAvailable,
      ensureTabAvailable,
    };
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => state,
      forProfile: () => profileCtx,
      mapTabError: vi.fn(() => null),
    } as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/doctor")?.(
      { params: {}, query: { profile: "work profile", deep: "true" } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = responseBodyRecord(response);
    expect(body.status).toMatchObject({ running: false });
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "live-snapshot", status: "fail" })]),
    );
    const liveSnapshot = (body.checks as Array<{ id?: string; fixHint?: string }>).find(
      (check) => check.id === "live-snapshot",
    );
    expect(liveSnapshot?.fixHint).toBe(
      "Run openclaw browser --browser-profile 'work profile' start, then retry with openclaw browser --browser-profile 'work profile' doctor --deep.",
    );
    expect(ensureBrowserAvailable).not.toHaveBeenCalled();
    expect(ensureTabAvailable).not.toHaveBeenCalled();
  });
});
