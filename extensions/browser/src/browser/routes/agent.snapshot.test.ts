import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshotAria = vi.fn();
const getPwAiModule = vi.fn();
const resolveProfileContext = vi.fn();
const resolveSnapshotPlan = vi.fn();
const shouldUsePlaywrightForAriaSnapshot = vi.fn();

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  snapshotAria,
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn(),
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
}));

vi.mock("../chrome-mcp.snapshot.js", () => ({
  buildAiSnapshotFromChromeMcpSnapshot: vi.fn(),
  flattenChromeMcpSnapshotToAriaNodes: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(),
  assertBrowserNavigationResultAllowed: vi.fn(),
  withBrowserNavigationPolicy: vi.fn(),
}));

vi.mock("../profile-capabilities.js", () => ({
  getBrowserProfileCapabilities: vi.fn(() => ({ usesChromeMcp: false })),
}));

vi.mock("../screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 1,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 1,
  normalizeBrowserScreenshot: vi.fn(),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: vi.fn(),
  saveMediaBuffer: vi.fn(),
}));

vi.mock("./agent.shared.js", () => ({
  getPwAiModule,
  handleRouteError: vi.fn((_, __, err) => {
    throw err;
  }),
  readBody: vi.fn(() => ({})),
  requirePwAi: vi.fn(),
  resolveProfileContext,
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(),
}));

vi.mock("./agent.snapshot.plan.js", () => ({
  resolveSnapshotPlan,
  shouldUsePlaywrightForAriaSnapshot,
  shouldUsePlaywrightForScreenshot: vi.fn(),
}));

vi.mock("./utils.js", () => ({
  jsonError: vi.fn((res, _status, message) => res.json({ ok: false, message })),
  toBoolean: vi.fn(),
  toStringOrEmpty: vi.fn(() => ""),
}));

describe("registerBrowserAgentSnapshotRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps CDP aria snapshots working when Playwright is unavailable", async () => {
    getPwAiModule.mockResolvedValue(null);
    resolveSnapshotPlan.mockReturnValue({
      format: "aria",
      limit: 1,
      labels: false,
      mode: undefined,
    });
    shouldUsePlaywrightForAriaSnapshot.mockReturnValue(false);
    resolveProfileContext.mockReturnValue({
      profile: { cdpUrl: "http://127.0.0.1:9222", name: "openclaw" },
      ensureTabAvailable: vi.fn(async () => ({
        targetId: "tab-1",
        wsUrl: "ws://127.0.0.1/devtools/page/tab-1",
        url: "https://example.com",
      })),
    });
    snapshotAria.mockResolvedValue({
      nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
    });

    const app = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
    };
    const ctx = {
      mapTabError: vi.fn(),
      state: vi.fn(() => ({ resolved: { ssrfPolicy: {} } })),
    };
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    const mod = await import("./agent.snapshot.js");
    mod.registerBrowserAgentSnapshotRoutes(app as never, ctx as never);

    const snapshotHandler = app.get.mock.calls.find(([path]) => path === "/snapshot")?.[1];
    expect(snapshotHandler).toBeTypeOf("function");

    await snapshotHandler({ query: {}, params: {} }, res);

    expect(snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/tab-1",
      limit: 1,
    });
    expect(getPwAiModule).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      format: "aria",
      targetId: "tab-1",
      url: "https://example.com",
      nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
    });
  });
});
