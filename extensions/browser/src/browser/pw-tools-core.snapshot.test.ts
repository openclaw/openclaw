import { beforeEach, describe, expect, it, vi } from "vitest";

const getPageForTargetId = vi.fn();
const ensurePageState = vi.fn();
const storeRoleRefsForTarget = vi.fn();
const withPageScopedCdpClient = vi.fn();
const markBackendDomRefsOnPage = vi.fn();
const formatAriaSnapshot = vi.fn();

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely: vi.fn(),
  ensurePageState,
  forceDisconnectPlaywrightForTarget: vi.fn(),
  getPageForTargetId,
  gotoPageWithNavigationGuard: vi.fn(),
  storeRoleRefsForTarget,
}));

vi.mock("./pw-session.page-cdp.js", () => ({
  markBackendDomRefsOnPage,
  withPageScopedCdpClient,
}));

vi.mock("./cdp.js", () => ({
  formatAriaSnapshot,
}));

describe("pw-tools-core aria snapshot storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the resolved page when storing aria refs", async () => {
    const page = { id: "page-1" };
    const rawNodes = [{ backendDOMNodeId: 42 }];
    const formattedNodes = [{ ref: "ax1", role: "button", name: "OK", backendDOMNodeId: 42 }];

    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);
    markBackendDomRefsOnPage.mockResolvedValue(new Set(["ax1"]));

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      limit: 5,
    });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(ensurePageState).toHaveBeenCalledWith(page);
    expect(withPageScopedCdpClient).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      page,
      targetId: "tab-1",
      fn: expect.any(Function),
    });
    expect(markBackendDomRefsOnPage).toHaveBeenCalledWith({
      page,
      refs: [{ ref: "ax1", backendDOMNodeId: 42 }],
    });
    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refs: {
        ax1: { role: "button", name: "OK", backendDOMNodeId: 42 },
      },
      mode: "role",
    });
  });
});
