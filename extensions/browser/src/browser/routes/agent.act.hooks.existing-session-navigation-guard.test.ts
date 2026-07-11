// Browser tests cover existing-session hook navigation safety.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  evaluateChromeMcpScript: vi.fn(async (_opts: unknown) => "https://example.com/form"),
  handleChromeMcpDialog: vi.fn(async () => false),
  uploadChromeMcpFile: vi.fn(async () => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn(
    (ssrfPolicy?: unknown, opts?: { browserProxyMode?: string }) => ({
      ...(ssrfPolicy ? { ssrfPolicy } : {}),
      ...(opts?.browserProxyMode ? { browserProxyMode: opts.browserProxyMode } : {}),
    }),
  ),
}));

const pathMocks = vi.hoisted(() => ({
  resolveExistingUploadPaths: vi.fn(async () => ({
    ok: true as const,
    paths: ["/private/tmp/openclaw/uploads/report.txt"],
  })),
}));

vi.mock("../chrome-mcp.js", () => chromeMcpMocks);
vi.mock("../navigation-guard.js", () => navigationGuardMocks);
vi.mock("../paths.js", () => pathMocks);
vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");
const routeState = existingSessionRouteState;

describe("existing-session hook navigation guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    routeState.tab.url = "https://example.com/form";
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com/form");
    chromeMcpMocks.handleChromeMcpDialog.mockResolvedValue(false);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    routeState.profileCtx.listTabs.mockResolvedValue([
      { targetId: "7", url: "https://example.com/form" },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the upload on the exact target, then verifies its resulting navigation", async () => {
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/file-chooser");
    expect(handler).toBeTypeOf("function");
    const response = createBrowserRouteResponse();
    const requestSignal = new AbortController().signal;

    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { targetId: "7", inputRef: "upload-1", paths: ["report.txt"] },
        signal: requestSignal,
      },
      response.res,
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.uploadChromeMcpFile).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: routeState.profileCtx.profile,
      targetId: "7",
      uid: "upload-1",
      filePath: "/private/tmp/openclaw/uploads/report.txt",
      timeoutMs: 60_000,
      signal: requestSignal,
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(5);
    for (const [call] of chromeMcpMocks.evaluateChromeMcpScript.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          targetId: "7",
          timeoutMs: 60_000,
          signal: requestSignal,
          fn: "() => window.location.href",
        }),
      );
    }
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(5);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com/form",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledTimes(2);
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledWith({
      timeoutMs: 60_000,
      signal: requestSignal,
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript.mock.invocationCallOrder[0]).toBeLessThan(
      chromeMcpMocks.uploadChromeMcpFile.mock.invocationCallOrder[0]!,
    );
  });

  it("blocks a private URL observed immediately before uploading a resolved file", async () => {
    const privateUrl = "http://169.254.169.254/latest/meta-data/";
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue(privateUrl);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === privateUrl) {
          throw new Error("blocked upload preflight");
        }
      },
    );
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/file-chooser");
    const response = createBrowserRouteResponse();

    await expect(
      handler?.(
        {
          params: {},
          query: {},
          body: { targetId: "7", inputRef: "upload-1", paths: ["report.txt"] },
          signal: new AbortController().signal,
        },
        response.res,
      ),
    ).rejects.toThrow("blocked upload preflight");

    expect(pathMocks.resolveExistingUploadPaths).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.uploadChromeMcpFile).not.toHaveBeenCalled();
  });

  it("fails closed when the immediate upload location probe fails", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockRejectedValue(new Error("location unavailable"));
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/file-chooser");
    const response = createBrowserRouteResponse();

    await expect(
      handler?.(
        {
          params: {},
          query: {},
          body: { targetId: "7", inputRef: "upload-1", paths: ["report.txt"] },
          signal: new AbortController().signal,
        },
        response.res,
      ),
    ).rejects.toThrow("location unavailable");

    expect(chromeMcpMocks.uploadChromeMcpFile).not.toHaveBeenCalled();
  });

  it("rejects a disallowed current page before resolving or uploading the file", async () => {
    const privateUrl = "http://169.254.169.254/latest/meta-data/";
    routeState.tab.url = privateUrl;
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === privateUrl) {
          throw new Error("blocked current tab");
        }
      },
    );
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/file-chooser");
    const response = createBrowserRouteResponse();

    await expect(
      handler?.(
        {
          params: {},
          query: {},
          body: { targetId: "7", inputRef: "upload-1", paths: ["report.txt"] },
          signal: new AbortController().signal,
        },
        response.res,
      ),
    ).rejects.toThrow("blocked current tab");

    expect(pathMocks.resolveExistingUploadPaths).not.toHaveBeenCalled();
    expect(chromeMcpMocks.uploadChromeMcpFile).not.toHaveBeenCalled();
  });

  it("handles a pending dialog natively before running the full postflight", async () => {
    chromeMcpMocks.handleChromeMcpDialog.mockResolvedValue(true);
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/dialog");
    const response = createBrowserRouteResponse();
    const signal = new AbortController().signal;

    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { targetId: "7", accept: true, promptText: "approved" },
        signal,
      },
      response.res,
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.handleChromeMcpDialog).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: routeState.profileCtx.profile,
      targetId: "7",
      timeoutMs: 60_000,
      signal,
      accept: true,
      promptText: "approved",
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(3);
    for (const [call] of chromeMcpMocks.evaluateChromeMcpScript.mock.calls) {
      expect(call).toEqual(expect.objectContaining({ fn: "() => window.location.href" }));
    }
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledTimes(3);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(4);
    expect(
      navigationGuardMocks.assertBrowserNavigationResultAllowed.mock.invocationCallOrder[0],
    ).toBeLessThan(chromeMcpMocks.handleChromeMcpDialog.mock.invocationCallOrder[0]!);
  });

  it("falls back to the guarded arm-next hook when no dialog is pending", async () => {
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/dialog");
    const response = createBrowserRouteResponse();

    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { targetId: "7", accept: false },
        signal: new AbortController().signal,
      },
      response.res,
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.handleChromeMcpDialog).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(6);
    expect(
      chromeMcpMocks.evaluateChromeMcpScript.mock.calls.some(([call]) =>
        String((call as { fn?: string }).fn).includes("__openclawDialogHook"),
      ),
    ).toBe(true);
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledTimes(4);
  });

  it("blocks a listed private dialog owner before native response dispatch", async () => {
    const privateUrl = "http://169.254.169.254/latest/meta-data/";
    routeState.profileCtx.listTabs.mockResolvedValue([{ targetId: "7", url: privateUrl }]);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === privateUrl) {
          throw new Error("blocked pending dialog owner");
        }
      },
    );
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActHookRoutes(app, {
      state: () => ({
        resolved: {
          actionTimeoutMs: 60_000,
          ssrfPolicy: { allowPrivateNetwork: false },
        },
      }),
    } as never);
    const handler = postHandlers.get("/hooks/dialog");
    const response = createBrowserRouteResponse();

    await expect(
      handler?.(
        {
          params: {},
          query: {},
          body: { targetId: "7", accept: false },
          signal: new AbortController().signal,
        },
        response.res,
      ),
    ).rejects.toThrow("blocked pending dialog owner");

    expect(chromeMcpMocks.handleChromeMcpDialog).not.toHaveBeenCalled();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });
});
