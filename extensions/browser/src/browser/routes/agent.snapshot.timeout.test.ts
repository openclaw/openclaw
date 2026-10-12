import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const cdpMocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
}));
const tabLookup = vi.hoisted(() => vi.fn());

const profileContext = vi.hoisted(() => ({
  profile: {
    name: "openclaw",
    driver: "openclaw" as const,
    cdpPort: 18_800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#FF4500",
    headless: false,
    attachOnly: false,
  },
}));
const browserRuntime = vi.hoisted(() => ({
  profiles: new Map<
    string,
    {
      running: { headless?: boolean; headlessSource?: string } | null;
      externalBrowserMode?: { browserWebSocketUrl: string; headless: Promise<boolean | undefined> };
    }
  >(),
}));
const pwMocks = vi.hoisted(() => ({
  connected: false,
  hasCachedPlaywrightBrowserConnection: vi.fn(() => pwMocks.connected),
  takeScreenshotViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("owned screenshot") })),
}));

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => null),
  getLoadedPwAiModule: () => pwMocks,
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: cdpMocks.captureScreenshot,
  getDocumentIdentitiesViaCdp: vi.fn(),
  snapshotAria: vi.fn(),
  snapshotRoleViaCdp: vi.fn(),
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn(),
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

vi.mock("../screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buffer: Buffer) => ({
    buffer,
    sourceDimensions: null,
    contentType: "image/png",
  })),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./agent.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent.shared.js")>()),
  browserNavigationPolicyForProfile: vi.fn(() => ({})),
  handleRouteError: vi.fn((_res, err) => {
    throw err;
  }),
  readBody: vi.fn((req: { body?: unknown }) => req.body ?? {}),
  requirePwAi: vi.fn(async () => pwMocks),
  resolveProfileContext: vi.fn(() => profileContext),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(
    async (params: {
      run: (ctx: {
        profileCtx: typeof profileContext;
        tab: { targetId: string; url: string; wsUrl: string; wsLookup: typeof tabLookup };
        cdpUrl: string;
      }) => Promise<void>;
    }) =>
      await params.run({
        profileCtx: profileContext,
        tab: {
          targetId: "tab-1",
          url: "https://example.com",
          wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
          wsLookup: tabLookup,
        },
        cdpUrl: "http://127.0.0.1:18800",
      }),
  ),
}));

const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

function getScreenshotHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { extraArgs: [] }, profiles: browserRuntime.profiles }),
  } as never);
  const handler = postHandlers.get("/screenshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("browser agent snapshot timeout routing", () => {
  beforeEach(() => {
    cdpMocks.captureScreenshot.mockReset();
    profileContext.profile.headless = false;
    browserRuntime.profiles.clear();
    pwMocks.connected = false;
    pwMocks.takeScreenshotViaPlaywright.mockClear();
  });

  it("uses the existing Playwright viewport owner even when the tab has a CDP URL", async () => {
    pwMocks.connected = true;
    cdpMocks.captureScreenshot.mockRejectedValueOnce(new Error("fresh CDP loses the viewport"));
    const handler = getScreenshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      { params: {}, query: {}, body: { type: "png", timeoutMs: 4321 } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(pwMocks.takeScreenshotViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:18800",
        targetId: "tab-1",
        timeoutMs: 4321,
      }),
    );
    expect(cdpMocks.captureScreenshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "headed launched browser when its profile is configured headless",
      configuredHeadless: true,
      running: { headless: false, headlessSource: "request" },
      expectedHeadless: false,
    },
    {
      name: "observed headed external browser",
      configuredHeadless: true,
      running: null,
      externalHeadless: false,
      expectedHeadless: false,
    },
  ])(
    "passes the actual launch mode for $name",
    async ({ configuredHeadless, running, externalHeadless, expectedHeadless }) => {
      profileContext.profile.headless = configuredHeadless;
      browserRuntime.profiles.set(profileContext.profile.name, {
        running,
        ...(typeof externalHeadless === "boolean"
          ? {
              externalBrowserMode: {
                browserWebSocketUrl: "ws://127.0.0.1:18800/devtools/browser/test-browser",
                headless: Promise.resolve(externalHeadless),
              },
            }
          : {}),
      });
      cdpMocks.captureScreenshot.mockResolvedValueOnce(Buffer.from("png"));
      const handler = getScreenshotHandler();
      const response = createBrowserRouteResponse();

      await handler?.({ params: {}, query: {}, body: { type: "png" } }, response.res);

      expect(response.statusCode).toBe(200);
      expect(cdpMocks.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ headless: expectedHeadless }),
      );
    },
  );

  it("rejects loose screenshot timeoutMs values before dispatching", async () => {
    const handler = getScreenshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      { params: {}, query: {}, body: { type: "png", timeoutMs: "1e3" } },
      response.res,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "timeoutMs must be a positive integer." });
    expect(cdpMocks.captureScreenshot).not.toHaveBeenCalled();
  });
});
