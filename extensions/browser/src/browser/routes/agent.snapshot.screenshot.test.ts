import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hyprland-capture.js", () => ({
  tryHyprlandViewportCapture: vi.fn().mockResolvedValue(null),
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn().mockResolvedValue(Buffer.from("cdp-png")),
  snapshotAria: vi.fn(),
}));

vi.mock("../chrome-mcp.js", () => ({
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
  evaluateChromeMcpScript: vi.fn(),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: vi.fn().mockResolvedValue(undefined),
  saveMediaBuffer: vi.fn().mockResolvedValue({ path: "/tmp/screenshot.png" }),
}));

vi.mock("../screenshot.js", () => ({
  normalizeBrowserScreenshot: vi.fn().mockResolvedValue({
    buffer: Buffer.from("normalized"),
    contentType: "image/jpeg",
  }),
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 10_000_000,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 1920,
}));

vi.mock("./agent.shared.js", async () => {
  const actual = await vi.importActual<typeof import("./agent.shared.js")>("./agent.shared.js");
  return {
    ...actual,
    withRouteTabContext: vi.fn(),
    requirePwAi: vi.fn().mockResolvedValue(null),
    getPwAiModule: vi.fn().mockResolvedValue(null),
    resolveProfileContext: vi.fn(),
    withPlaywrightRouteContext: vi.fn(),
  };
});

vi.mock("../browser-proxy-mode.js", () => ({
  resolveBrowserNavigationProxyMode: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../navigation-guard.js", () => ({
  withBrowserNavigationPolicy: vi.fn().mockReturnValue({}),
  assertBrowserNavigationAllowed: vi.fn().mockResolvedValue(undefined),
  assertBrowserNavigationResultAllowed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../profile-capabilities.js", () => ({
  getBrowserProfileCapabilities: vi.fn().mockReturnValue({ usesChromeMcp: false }),
  shouldUsePlaywrightForScreenshot: vi.fn().mockReturnValue(false),
}));

import { captureScreenshot } from "../cdp.js";
import { tryHyprlandViewportCapture } from "../hyprland-capture.js";
import {
  getBrowserProfileCapabilities,
  shouldUsePlaywrightForScreenshot,
} from "../profile-capabilities.js";
import { normalizeBrowserScreenshot } from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.types.js";
import { withRouteTabContext } from "./agent.shared.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRouteHandler } from "./types.js";

const mockWithRouteTabContext = vi.mocked(withRouteTabContext);
const mockTryHyprland = vi.mocked(tryHyprlandViewportCapture);
const mockCaptureScreenshot = vi.mocked(captureScreenshot);
const mockGetBrowserProfileCapabilities = vi.mocked(getBrowserProfileCapabilities);
const mockShouldUsePlaywrightForScreenshot = vi.mocked(shouldUsePlaywrightForScreenshot);
const mockNormalize = vi.mocked(normalizeBrowserScreenshot);

const FAKE_PROFILE = {
  name: "openclaw",
  driver: "openclaw" as const,
  cdpPort: 18792,
  cdpUrl: "http://127.0.0.1:18792",
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  headless: false,
  attachOnly: false,
};

const FAKE_TAB = {
  targetId: "target-1",
  title: "Example",
  url: "http://example.com",
  wsUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
};

function makeCtx(opts: {
  headless?: boolean;
  hyprlandViewportCapture?: boolean;
  pid?: number | null;
}): BrowserRouteContext {
  const running = opts.pid != null ? { pid: opts.pid } : null;
  const profiles = new Map([["openclaw", { profile: FAKE_PROFILE, running }]]);

  return {
    state: () => ({
      port: 18791,
      resolved: {
        headless: opts.headless ?? false,
        hyprlandViewportCapture: opts.hyprlandViewportCapture ?? false,
        ssrfPolicy: undefined,
      } as never,
      profiles,
    }),
    forProfile: () => ({ profile: FAKE_PROFILE }) as never,
    listProfiles: vi.fn(),
    mapTabError: vi.fn(),
    ensureBrowserAvailable: vi.fn(),
    ensureTabAvailable: vi.fn(),
    isHttpReachable: vi.fn(),
    isTransportAvailable: vi.fn(),
    isReachable: vi.fn(),
    listTabs: vi.fn(),
    openTab: vi.fn(),
    labelTab: vi.fn(),
    focusTab: vi.fn(),
    closeTab: vi.fn(),
    stopRunningBrowser: vi.fn(),
    resetProfile: vi.fn(),
  } as unknown as BrowserRouteContext;
}

async function callScreenshotRoute(
  ctx: BrowserRouteContext,
  body: Record<string, unknown> = {},
): Promise<ReturnType<typeof createBrowserRouteResponse>> {
  const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, ctx);
  const handler = postHandlers.get("/screenshot") as BrowserRouteHandler;
  const response = createBrowserRouteResponse();
  await handler({ body, params: {}, query: {} } as never, response.res);
  return response;
}

beforeEach(() => {
  mockWithRouteTabContext.mockImplementation(async ({ run }) => {
    await run({
      profileCtx: { profile: FAKE_PROFILE, listTabs: vi.fn() } as never,
      tab: { ...FAKE_TAB },
      cdpUrl: "http://127.0.0.1:18792",
    });
  });
  mockTryHyprland.mockResolvedValue(null);
  mockCaptureScreenshot.mockResolvedValue(Buffer.from("cdp-png"));
  mockGetBrowserProfileCapabilities.mockReturnValue({ usesChromeMcp: false } as never);
  mockShouldUsePlaywrightForScreenshot.mockReturnValue(false);
  mockNormalize.mockResolvedValue({ buffer: Buffer.from("normalized"), contentType: "image/jpeg" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("screenshot route — hyprlandViewportCapture flag", () => {
  it("does not call tryHyprlandViewportCapture when flag is false", async () => {
    const ctx = makeCtx({ hyprlandViewportCapture: false, pid: 42 });
    await callScreenshotRoute(ctx);
    expect(mockTryHyprland).not.toHaveBeenCalled();
    expect(mockCaptureScreenshot).toHaveBeenCalled();
  });

  it("does not call tryHyprlandViewportCapture when headless is true", async () => {
    const ctx = makeCtx({ hyprlandViewportCapture: true, headless: true, pid: 42 });
    await callScreenshotRoute(ctx);
    expect(mockTryHyprland).not.toHaveBeenCalled();
  });

  it("does not call tryHyprlandViewportCapture when fullPage is true", async () => {
    const ctx = makeCtx({ hyprlandViewportCapture: true, headless: false, pid: 42 });
    await callScreenshotRoute(ctx, { fullPage: true });
    expect(mockTryHyprland).not.toHaveBeenCalled();
  });

  it("does not call tryHyprlandViewportCapture when no running pid", async () => {
    const ctx = makeCtx({ hyprlandViewportCapture: true, headless: false, pid: null });
    await callScreenshotRoute(ctx);
    expect(mockTryHyprland).not.toHaveBeenCalled();
  });

  it("calls tryHyprlandViewportCapture when flag is true and headed and has pid", async () => {
    const ctx = makeCtx({ hyprlandViewportCapture: true, headless: false, pid: 42 });
    await callScreenshotRoute(ctx);
    expect(mockTryHyprland).toHaveBeenCalledWith(expect.objectContaining({ browserPid: 42 }));
  });
});

describe("screenshot route — PNG type coercion on Hyprland path", () => {
  it("forces type to png when Hyprland capture returns data", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockTryHyprland.mockResolvedValue(pngBytes);
    const ctx = makeCtx({ hyprlandViewportCapture: true, headless: false, pid: 42 });
    await callScreenshotRoute(ctx, { type: "jpeg" });
    expect(mockCaptureScreenshot).not.toHaveBeenCalled();
  });

  it("falls back to CDP when tryHyprlandViewportCapture returns null", async () => {
    mockTryHyprland.mockResolvedValue(null);
    const ctx = makeCtx({ hyprlandViewportCapture: true, headless: false, pid: 42 });
    await callScreenshotRoute(ctx);
    expect(mockCaptureScreenshot).toHaveBeenCalled();
  });
});
