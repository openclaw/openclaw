// Browser tests cover file-upload hooks for existing-session navigation safety.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  evaluateChromeMcpScript: vi.fn(async () => "https://example.com/form"),
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

describe("existing-session file upload navigation guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com/form");
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
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(3);
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
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(3);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com/form",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledTimes(2);
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledWith({
      timeoutMs: 60_000,
      signal: requestSignal,
    });
    expect(chromeMcpMocks.uploadChromeMcpFile.mock.invocationCallOrder[0]).toBeLessThan(
      chromeMcpMocks.evaluateChromeMcpScript.mock.invocationCallOrder[0]!,
    );
  });
});
