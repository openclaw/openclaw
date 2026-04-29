import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTargetIdAfterNavigate } from "./agent.snapshot-target.js";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

const mockCaptureWithHyprland = vi.hoisted(() => vi.fn<() => Promise<Buffer>>());
const mockIsHyprlandAvailable = vi.hoisted(() => vi.fn<() => boolean>());
const mockCaptureScreenshot = vi.hoisted(() => vi.fn<() => Promise<Buffer>>());
const mockNormalizeBrowserScreenshot = vi.hoisted(() => vi.fn());
const mockSaveMediaBuffer = vi.hoisted(() => vi.fn());
const mockEnsureMediaDir = vi.hoisted(() => vi.fn());
const mockWithRouteTabContext = vi.hoisted(() => vi.fn());
const mockGetBrowserProfileCapabilities = vi.hoisted(() => vi.fn());
const mockShouldUsePlaywrightForScreenshot = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks — pure factories, no importOriginal
// ---------------------------------------------------------------------------

vi.mock("../hyprland-capture.js", () => ({
  captureWithHyprland: mockCaptureWithHyprland,
  isHyprlandAvailable: mockIsHyprlandAvailable,
  isHyprlandEnvironment: mockIsHyprlandAvailable,
  teardownHyprlandCapture: vi.fn().mockResolvedValue(undefined),
  _resetHyprlandCaptureForTests: vi.fn(),
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: mockCaptureScreenshot,
  snapshotAria: vi.fn().mockResolvedValue({ nodes: [] }),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: mockEnsureMediaDir,
  saveMediaBuffer: mockSaveMediaBuffer,
}));

vi.mock("../screenshot.js", () => ({
  normalizeBrowserScreenshot: mockNormalizeBrowserScreenshot,
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 5_000_000,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 1920,
}));

vi.mock("../profile-capabilities.js", () => ({
  getBrowserProfileCapabilities: mockGetBrowserProfileCapabilities,
  shouldUsePlaywrightForScreenshot: mockShouldUsePlaywrightForScreenshot,
  shouldUsePlaywrightForAriaSnapshot: vi.fn().mockReturnValue(false),
  resolveDefaultSnapshotFormat: vi.fn().mockReturnValue("aria"),
}));

vi.mock("./agent.shared.js", () => ({
  withRouteTabContext: mockWithRouteTabContext,
  withPlaywrightRouteContext: vi.fn(),
  readBody: (req: { body?: unknown }) =>
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {},
  resolveProfileContext: vi.fn(),
  getPwAiModule: vi.fn().mockResolvedValue(null),
  requirePwAi: vi.fn().mockResolvedValue(null),
  handleRouteError: vi.fn(),
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn().mockResolvedValue([]),
  navigateChromeMcpPage: vi.fn().mockResolvedValue({ url: "" }),
  takeChromeMcpScreenshot: vi.fn().mockResolvedValue(Buffer.from("")),
  takeChromeMcpSnapshot: vi.fn().mockResolvedValue({}),
}));

vi.mock("../chrome-mcp.snapshot.js", () => ({
  buildAiSnapshotFromChromeMcpSnapshot: vi.fn().mockReturnValue({ snapshot: "", refs: {} }),
  flattenChromeMcpSnapshotToAriaNodes: vi.fn().mockReturnValue([]),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn().mockResolvedValue(undefined),
  assertBrowserNavigationResultAllowed: vi.fn().mockResolvedValue(undefined),
  withBrowserNavigationPolicy: vi.fn().mockReturnValue({}),
}));

vi.mock("../browser-proxy-mode.js", () => ({
  resolveBrowserNavigationProxyMode: vi.fn().mockReturnValue({}),
}));

vi.mock("./agent.snapshot.plan.js", () => ({
  resolveSnapshotPlan: vi.fn().mockReturnValue({ format: "aria", limit: 10 }),
  shouldUsePlaywrightForAriaSnapshot: vi.fn().mockReturnValue(false),
  shouldUsePlaywrightForScreenshot: mockShouldUsePlaywrightForScreenshot,
}));

vi.mock("./existing-session-limits.js", () => ({
  EXISTING_SESSION_LIMITS: {
    snapshot: {
      pdfUnsupported: "unsupported",
      screenshotElement: "unsupported",
      snapshotSelector: "unsupported",
    },
  },
}));

// Import route AFTER all mocks are in place.
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteHandler } from "./types.js";

// ---------------------------------------------------------------------------
// /screenshot route — Hyprland path selection tests
// ---------------------------------------------------------------------------

const fakeTab = {
  targetId: "target-1",
  url: "https://example.com",
  wsUrl: "ws://localhost:9222/devtools/page/1",
};

function makeCtx(opts: { hyprlandCapture?: boolean; pid?: number } = {}) {
  return {
    state: () => ({
      resolved: {
        hyprlandCapture: opts.hyprlandCapture ?? false,
        ssrfPolicy: undefined,
      },
      profiles: new Map([
        ["openclaw", { running: opts.pid != null ? { pid: opts.pid } : undefined }],
      ]),
    }),
    mapTabError: () => null,
  } as unknown as Parameters<typeof registerBrowserAgentSnapshotRoutes>[1];
}

// ---------------------------------------------------------------------------
// resolveTargetIdAfterNavigate tests
// ---------------------------------------------------------------------------

type Tab = { targetId: string; url: string };

function staticListTabs(tabs: Tab[]): () => Promise<Tab[]> {
  return async () => tabs;
}

describe("resolveTargetIdAfterNavigate", () => {
  it("returns original targetId when old target still exists (no swap)", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://example.com",
      listTabs: staticListTabs([
        { targetId: "old-123", url: "https://example.com" },
        { targetId: "other-456", url: "https://other.com" },
      ]),
    });
    expect(result).toBe("old-123");
  });

  it("resolves new targetId when old target is gone (renderer swap)", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://example.com",
      listTabs: staticListTabs([{ targetId: "new-456", url: "https://example.com" }]),
    });
    expect(result).toBe("new-456");
  });

  it("prefers non-stale targetId when multiple tabs share the URL", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://example.com",
      retryDelayMs: 0,
      listTabs: staticListTabs([
        { targetId: "preexisting-000", url: "https://example.com" },
        { targetId: "fresh-777", url: "https://example.com" },
      ]),
    });
    // Ambiguous replacement; prefer staying on the old target rather than guessing wrong.
    expect(result).toBe("old-123");
  });

  it("retries and resolves targetId when first listTabs has no URL match", async () => {
    let calls = 0;

    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://delayed.com",
      retryDelayMs: 0,
      listTabs: async () => {
        calls++;
        if (calls === 1) {
          return [{ targetId: "unrelated-1", url: "https://unrelated.com" }];
        }
        return [{ targetId: "delayed-999", url: "https://delayed.com" }];
      },
    });

    expect(result).toBe("delayed-999");
    expect(calls).toBe(2);
  });

  it("falls back to original targetId when no match found after retry", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://no-match.com",
      retryDelayMs: 0,
      listTabs: staticListTabs([
        { targetId: "unrelated-1", url: "https://unrelated.com" },
        { targetId: "unrelated-2", url: "https://unrelated2.com" },
      ]),
    });

    expect(result).toBe("old-123");
  });

  it("falls back to single remaining tab when no URL match after retry", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://single-tab.com",
      retryDelayMs: 0,
      listTabs: staticListTabs([{ targetId: "only-tab", url: "https://some-other.com" }]),
    });

    expect(result).toBe("only-tab");
  });

  it("falls back to original targetId when listTabs throws", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://error.com",
      listTabs: async () => {
        throw new Error("CDP connection lost");
      },
    });
    expect(result).toBe("old-123");
  });

  it("keeps the old target when multiple replacement candidates still match after retry", async () => {
    const result = await resolveTargetIdAfterNavigate({
      oldTargetId: "old-123",
      navigatedUrl: "https://example.com",
      retryDelayMs: 0,
      listTabs: staticListTabs([
        { targetId: "preexisting-000", url: "https://example.com" },
        { targetId: "fresh-777", url: "https://example.com" },
      ]),
    });

    expect(result).toBe("old-123");
  });
});

// ---------------------------------------------------------------------------
// /screenshot route — Hyprland path selection tests
// ---------------------------------------------------------------------------

function makeProfileCtx(headless = false) {
  return {
    profile: {
      name: "openclaw",
      headless,
      cdpUrl: "http://localhost:9222",
    },
    listTabs: async () => [],
    ensureTabAvailable: async () => fakeTab,
  };
}

function captureScreenshotHandler(ctx: ReturnType<typeof makeCtx>): BrowserRouteHandler {
  const handlers = new Map<string, BrowserRouteHandler>();
  const app = {
    get: (p: string, h: BrowserRouteHandler) => {
      handlers.set(`GET ${p}`, h);
    },
    post: (p: string, h: BrowserRouteHandler) => {
      handlers.set(`POST ${p}`, h);
    },
    delete: (p: string, h: BrowserRouteHandler) => {
      handlers.set(`DELETE ${p}`, h);
    },
  };
  registerBrowserAgentSnapshotRoutes(app, ctx);
  return handlers.get("POST /screenshot")!;
}

function makeReq(body: Record<string, unknown> = {}): BrowserRequest {
  return { params: {}, query: {}, body };
}

function makeRes(): BrowserResponse & { lastJson: () => unknown } {
  let lastCall: unknown;
  return {
    status: function (this: BrowserResponse) {
      return this;
    },
    json: (body: unknown) => {
      lastCall = body;
    },
    lastJson: () => lastCall,
  } as unknown as BrowserResponse & { lastJson: () => unknown };
}

describe("screenshot route Hyprland path selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not Hyprland
    mockIsHyprlandAvailable.mockReturnValue(false);
    // Default: not Chrome MCP
    mockGetBrowserProfileCapabilities.mockReturnValue({ usesChromeMcp: false });
    // Default: don't use Playwright
    mockShouldUsePlaywrightForScreenshot.mockReturnValue(false);
    // Default: CDP returns fake buffer
    mockCaptureScreenshot.mockResolvedValue(Buffer.from("cdp-bytes"));
    // normalize passes buffer through
    mockNormalizeBrowserScreenshot.mockResolvedValue({
      buffer: Buffer.from("normalized"),
      contentType: "image/png",
    });
    mockEnsureMediaDir.mockResolvedValue(undefined);
    mockSaveMediaBuffer.mockResolvedValue({ path: "/tmp/fake.png" });

    // withRouteTabContext calls run() with a headed, non-Chrome-MCP profile
    mockWithRouteTabContext.mockImplementation(
      async (params: { run: (ctx: unknown) => Promise<void> }) => {
        await params.run({
          profileCtx: makeProfileCtx(false),
          tab: fakeTab,
          cdpUrl: "http://localhost:9222",
          resolveTabUrl: async () => "https://example.com",
        });
      },
    );
  });

  afterEach(() => {
    delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  });

  it("non-Hyprland environment → CDP captureScreenshot is called", async () => {
    mockIsHyprlandAvailable.mockReturnValue(false);
    const ctx = makeCtx({ hyprlandCapture: true, pid: 42 });
    const handler = captureScreenshotHandler(ctx);
    const res = makeRes();

    await handler(makeReq({ type: "png" }), res);

    expect(mockCaptureScreenshot).toHaveBeenCalledOnce();
    expect(mockCaptureWithHyprland).not.toHaveBeenCalled();
  });

  it("Hyprland available + headed + hyprlandCapture:true + pid → grim called, PNG returned", async () => {
    mockIsHyprlandAvailable.mockReturnValue(true);
    const fakePng = Buffer.from("\x89PNG\r\n\x1a\n");
    mockCaptureWithHyprland.mockResolvedValue(fakePng);
    mockNormalizeBrowserScreenshot.mockResolvedValue({
      buffer: fakePng,
      contentType: "image/png",
    });

    const ctx = makeCtx({ hyprlandCapture: true, pid: 42 });
    const handler = captureScreenshotHandler(ctx);
    const res = makeRes();

    await handler(makeReq({ type: "png" }), res);

    expect(mockCaptureWithHyprland).toHaveBeenCalledOnce();
    expect(mockCaptureScreenshot).not.toHaveBeenCalled();
    expect(mockSaveMediaBuffer).toHaveBeenCalled();
  });

  it("jpeg request on Hyprland path → screenshotType overridden to png", async () => {
    mockIsHyprlandAvailable.mockReturnValue(true);
    const fakePng = Buffer.from("\x89PNG\r\n\x1a\n");
    mockCaptureWithHyprland.mockResolvedValue(fakePng);
    mockNormalizeBrowserScreenshot.mockImplementation(async (buf: Buffer) => ({
      buffer: buf,
      contentType: "image/png",
    }));

    const ctx = makeCtx({ hyprlandCapture: true, pid: 42 });
    const handler = captureScreenshotHandler(ctx);
    const res = makeRes();

    await handler(makeReq({ type: "jpeg" }), res);

    expect(mockCaptureWithHyprland).toHaveBeenCalledOnce();
    // normalizeBrowserScreenshot must be called with the grim buffer (PNG), not a JPEG
    const [calledBuf] = mockNormalizeBrowserScreenshot.mock.calls[0] as [Buffer];
    expect(calledBuf).toEqual(fakePng);
    // CDP must not be called since grim succeeded
    expect(mockCaptureScreenshot).not.toHaveBeenCalled();
  });

  it("headless profile → Hyprland path skipped, CDP used instead", async () => {
    mockIsHyprlandAvailable.mockReturnValue(true);
    const fakePng = Buffer.from("\x89PNG\r\n\x1a\n");
    mockCaptureWithHyprland.mockResolvedValue(fakePng);

    // Override withRouteTabContext to inject a headless profile.
    mockWithRouteTabContext.mockImplementation(
      async (params: { run: (ctx: unknown) => Promise<void> }) => {
        await params.run({
          profileCtx: makeProfileCtx(true),
          tab: fakeTab,
          cdpUrl: "http://localhost:9222",
          resolveTabUrl: async () => "https://example.com",
        });
      },
    );

    const ctx = makeCtx({ hyprlandCapture: true, pid: 42 });
    const handler = captureScreenshotHandler(ctx);
    const res = makeRes();

    await handler(makeReq({ type: "png" }), res);

    expect(mockCaptureWithHyprland).not.toHaveBeenCalled();
    expect(mockCaptureScreenshot).toHaveBeenCalledOnce();
  });

  it("captureWithHyprland throws → falls back to CDP, does not rethrow", async () => {
    mockIsHyprlandAvailable.mockReturnValue(true);
    mockCaptureWithHyprland.mockRejectedValue(new Error("grim crashed"));

    const ctx = makeCtx({ hyprlandCapture: true, pid: 42 });
    const handler = captureScreenshotHandler(ctx);
    const res = makeRes();

    await handler(makeReq({ type: "png" }), res);

    expect(mockCaptureWithHyprland).toHaveBeenCalledOnce();
    expect(mockCaptureScreenshot).toHaveBeenCalledOnce();
  });

  it("concurrent viewport screenshot calls each complete and save", async () => {
    mockIsHyprlandAvailable.mockReturnValue(true);
    const fakePng = Buffer.from("\x89PNG");
    mockCaptureWithHyprland.mockResolvedValue(fakePng);
    mockNormalizeBrowserScreenshot.mockResolvedValue({
      buffer: fakePng,
      contentType: "image/png",
    });

    const ctx = makeCtx({ hyprlandCapture: true, pid: 42 });
    const handler = captureScreenshotHandler(ctx);

    await Promise.all([
      handler(makeReq({ type: "png" }), makeRes()),
      handler(makeReq({ type: "png" }), makeRes()),
      handler(makeReq({ type: "png" }), makeRes()),
    ]);

    expect(mockCaptureWithHyprland).toHaveBeenCalledTimes(3);
    expect(mockCaptureScreenshot).not.toHaveBeenCalled();
    expect(mockSaveMediaBuffer).toHaveBeenCalledTimes(3);
  });
});
