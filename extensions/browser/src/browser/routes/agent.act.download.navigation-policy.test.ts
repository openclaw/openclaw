// Browser tests cover agent.act.download navigation policy propagation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const pwMocks = vi.hoisted(() => ({
  downloadViaPlaywright: vi.fn(async () => ({ path: "/tmp/browser-downloads/report.pdf" })),
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    path: "/tmp/browser-downloads/report.pdf",
  })),
}));

const routeMocks = vi.hoisted(() => ({
  browserNavigationPolicyForProfile: vi.fn(() => ({
    ssrfPolicy: { allowPrivateNetwork: false },
    browserProxyMode: "explicit-browser-proxy" as const,
  })),
  ensureOutputRootDir: vi.fn(async () => {}),
  resolveWritableOutputPathOrRespond: vi.fn(async () => "/tmp/browser-downloads/report.pdf"),
}));

vi.mock("./agent.shared.js", () => ({
  browserNavigationPolicyForProfile: routeMocks.browserNavigationPolicyForProfile,
  readBody: vi.fn((req: { body?: Record<string, unknown> }) => req.body ?? {}),
  requirePwAi: vi.fn(async () => pwMocks),
  resolveTargetIdFromBody: vi.fn((body: Record<string, unknown>) => body.targetId),
  withRouteTabContext: vi.fn(
    async ({ run }: { run: (args: Record<string, unknown>) => Promise<void> }) => {
      await run({
        profileCtx: {
          profile: {
            cdpIsLoopback: true,
            driver: "openclaw",
            name: "openclaw",
          },
        },
        cdpUrl: "http://127.0.0.1:18800",
        tab: { targetId: "tab-1", url: "https://example.com" },
      });
    },
  ),
}));

vi.mock("./output-paths.js", () => ({
  ensureOutputRootDir: routeMocks.ensureOutputRootDir,
  resolveWritableOutputPathOrRespond: routeMocks.resolveWritableOutputPathOrRespond,
}));

vi.mock("./path-output.js", () => ({
  DEFAULT_DOWNLOAD_DIR: "/tmp/browser-downloads",
}));

const { registerBrowserAgentActDownloadRoutes } = await import("./agent.act.download.js");

describe("download route navigation policy", () => {
  beforeEach(() => {
    pwMocks.downloadViaPlaywright.mockClear();
    pwMocks.waitForDownloadViaPlaywright.mockClear();
    routeMocks.browserNavigationPolicyForProfile.mockClear();
    routeMocks.ensureOutputRootDir.mockClear();
    routeMocks.resolveWritableOutputPathOrRespond.mockClear();
  });

  it("passes the profile navigation policy and request signal to the download click", async () => {
    const { app, postHandlers } = createBrowserRouteApp();
    const ctx = {
      state: () => ({ resolved: { ssrfPolicy: { allowPrivateNetwork: false } } }),
    } as never;
    registerBrowserAgentActDownloadRoutes(app, ctx);
    const handler = postHandlers.get("/download");
    expect(handler).toBeTypeOf("function");
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();

    await handler?.(
      {
        params: {},
        query: {},
        body: { targetId: "tab-1", ref: "download-link", path: "report.pdf" },
        signal: ctrl.signal,
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(routeMocks.browserNavigationPolicyForProfile).toHaveBeenCalledOnce();
    expect(pwMocks.downloadViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      timeoutMs: undefined,
      ssrfPolicy: { allowPrivateNetwork: false },
      browserProxyMode: "explicit-browser-proxy",
      ref: "download-link",
      path: "/tmp/browser-downloads/report.pdf",
      rootDir: "/tmp/browser-downloads",
      signal: ctrl.signal,
    });
  });

  it("passes the profile navigation policy and request signal to a download waiter", async () => {
    const { app, postHandlers } = createBrowserRouteApp();
    const ctx = {
      state: () => ({ resolved: { ssrfPolicy: { allowPrivateNetwork: false } } }),
    } as never;
    registerBrowserAgentActDownloadRoutes(app, ctx);
    const handler = postHandlers.get("/wait/download");
    expect(handler).toBeTypeOf("function");
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();

    await handler?.(
      {
        params: {},
        query: {},
        body: { targetId: "tab-1" },
        signal: ctrl.signal,
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(pwMocks.waitForDownloadViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      timeoutMs: undefined,
      ssrfPolicy: { allowPrivateNetwork: false },
      browserProxyMode: "explicit-browser-proxy",
      path: undefined,
      rootDir: "/tmp/browser-downloads",
      signal: ctrl.signal,
    });
  });
});
