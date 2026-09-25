import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({ page: null as Record<string, unknown> | null }));
const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  ensurePageState: vi.fn(() => ({})),
  getPageForTargetId: vi.fn(async () => {
    if (!pageState.page) {
      throw new Error("missing page");
    }
    return pageState.page;
  }),
  storeRoleRefsForTarget: vi.fn(),
}));

const pageCdpMocks = vi.hoisted(() => ({
  markBackendDomRefsOnPage: vi.fn(async () => new Set<string>()),
  withCdpSnapshotRoot: vi.fn(
    async ({ run }: { run: (backendNodeId: number) => Promise<unknown> }) => await run(1),
  ),
  withPageScopedCdpClient: vi.fn(
    async ({ fn }: { fn: (send: () => Promise<unknown>) => unknown }) =>
      await fn(async () => ({
        nodes: [{ nodeId: "root", backendDOMNodeId: 1, role: { value: "generic" } }],
      })),
  ),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./pw-session.page-cdp.js", () => pageCdpMocks);
const snapshots = await import("./pw-tools-core.snapshot.js");

const strictNavigationOptions = () =>
  ({
    cdpUrl: "http://127.0.0.1:18792",
    targetId: "tab-1",
    ssrfPolicy: { allowPrivateNetwork: false },
  }) as const;

function completedNavigationExpectation() {
  return { ...strictNavigationOptions(), page: pageState.page, response: null };
}

function createSnapshotPage(overrides: Record<string, unknown>) {
  const mainFrame = {};
  return {
    mainFrame: vi.fn(() => mainFrame),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

describe("browser snapshot navigation policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageState.page = null;
  });

  it.each([
    {
      name: "snapshotting AI content",
      run: (options: Parameters<typeof snapshots.snapshotRoleViaPlaywright>[0]) =>
        snapshots.snapshotRoleViaPlaywright({ ...options, refsMode: "aria" }),
      prepare: () => {
        const ariaSnapshot = vi.fn(async () => 'button "Save"');
        return { page: createSnapshotPage({ ariaSnapshot }), capture: ariaSnapshot };
      },
    },
    {
      name: "role snapshots",
      run: snapshots.snapshotRoleViaPlaywright,
      prepare: () => {
        const elementHandle = vi.fn(async () => ({ dispose: vi.fn(async () => {}) }));
        return {
          page: createSnapshotPage({ locator: vi.fn(() => ({ elementHandle })) }),
          capture: pageCdpMocks.withPageScopedCdpClient,
        };
      },
    },
    {
      name: "aria snapshots",
      run: snapshots.snapshotAriaViaPlaywright,
      prepare: () => ({
        page: createSnapshotPage({}),
        capture: pageCdpMocks.withPageScopedCdpClient,
      }),
    },
  ])("re-checks current page URL before $name", async ({ run, prepare }) => {
    const { page, capture } = prepare();
    pageState.page = { ...page, url: vi.fn(() => "https://example.com") };

    await run(strictNavigationOptions());

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      completedNavigationExpectation(),
    );
    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledBefore(capture);
  });
});
