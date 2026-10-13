import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPageForTargetId = vi.fn();
const ensurePageState = vi.fn(() => ({}));
const storeRoleRefsForTarget = vi.fn();
const withPageScopedCdpClient = vi.fn();
const withCdpSnapshotRoot = vi.fn();
const snapshotRoleViaCdpSession = vi.fn();
const markBackendDomRefsOnPage = vi.fn();
const readDocumentIdentitiesForPage = vi.fn();
const formatAriaSnapshot = vi.fn();
const gotoPageWithNavigationGuard = vi.fn();
const createDownloadCaptureForPage = vi.fn(() => ({
  armed: true,
  promise: new Promise(() => {}),
  cancel: vi.fn(),
}));

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely: vi.fn(),
  closeBlockedNavigationTarget: vi.fn(),
  ensurePageState,
  forceDisconnectPlaywrightForTarget: vi.fn(),
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  isDownloadStartingNavigationError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn(() => false),
  storeRoleRefsForTarget,
}));

vi.mock("./pw-download-capture.js", () => ({
  createDownloadCaptureForPage,
}));

vi.mock("./pw-session.page-cdp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session.page-cdp.js")>()),
  markBackendDomRefsOnPage,
  readDocumentIdentitiesForPage,
  withPageScopedCdpClient,
  withCdpSnapshotRoot,
}));

vi.mock("./cdp-role-snapshot.js", () => ({ snapshotRoleViaCdpSession }));

vi.mock("./cdp.js", () => ({
  formatAriaSnapshot,
}));

function makeAriaSnapshotPage(ariaSnapshot: ReturnType<typeof vi.fn>) {
  const mainFrame = { id: "main-frame" };
  return {
    ariaSnapshot,
    mainFrame: () => mainFrame,
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeNativeSnapshotLocator() {
  const capture = {
    snapshot: '- button "Save" [ref=e1]',
    refs: { e1: { role: "button", name: "Save", backendDOMNodeId: 42 } },
    stats: { lines: 1, chars: 29, refs: 1, interactive: 1 },
  };
  snapshotRoleViaCdpSession.mockResolvedValue(capture);
  withPageScopedCdpClient.mockImplementation(async ({ fn }) => await fn(vi.fn()));
  withCdpSnapshotRoot.mockImplementation(async ({ run }) => await run(42));
  markBackendDomRefsOnPage.mockResolvedValue(new Set(["e1"]));
  return {
    count: vi.fn(async () => 1),
    elementHandle: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
    capture,
  };
}

const mod = await import("./pw-tools-core.snapshot.js");

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };

describe("pw-tools-core aria snapshot storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the resolved page when storing aria refs", async () => {
    const page = makeAriaSnapshotPage(vi.fn());
    const rawNodes = [{ backendDOMNodeId: 42 }];
    const formattedNodes = [
      { ref: "ax1", role: "Button", name: "OK", backendDOMNodeId: 42, depth: 0 },
      { ref: "ax2", role: "Button", name: "OK", backendDOMNodeId: 84, depth: 0 },
      { ref: "ax3", role: "Button", name: "", depth: 0 },
    ];

    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);
    markBackendDomRefsOnPage.mockResolvedValue(new Set());

    const result = await mod.snapshotAriaViaPlaywright({
      ...target,
      limit: 5,
    });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(ensurePageState).toHaveBeenCalledWith(page);
    expect(withPageScopedCdpClient).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page, fn: expect.any(Function) }),
    );
    expect(markBackendDomRefsOnPage).toHaveBeenCalledWith({
      page,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
      assertCurrent: expect.any(Function),
    });
    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      ...target,
      refs: {
        ax1: { role: "button", name: "OK", nth: 0, domMarker: true },
        ax2: { role: "button", name: "OK", nth: 1, domMarker: true },
        ax3: { role: "button", name: "" },
      },
      mode: "role",
    });
  });

  it("does not publish refs after a pending binding is cancelled", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const controller = new AbortController();
    const reason = new Error("cancelled capture");
    getPageForTargetId.mockResolvedValue(makeAriaSnapshotPage(vi.fn()));
    markBackendDomRefsOnPage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return new Set();
    });
    const pending = mod.storeSnapshotRefsViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
      refs: { e1: { role: "button", name: "Cancelled" } },
    });
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    await expect(pending).rejects.toBe(reason);
    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it.each([750])("bounds a stalled ARIA snapshot with timeoutMs=%s", async (timeoutMs) => {
    const actual = await vi.importActual<typeof import("./pw-session.page-cdp.js")>(
      "./pw-session.page-cdp.js",
    );
    const tree = createDeferred<{ nodes: [] }>();
    const detach = vi.fn(async () => {});
    const page = {
      ...makeAriaSnapshotPage(vi.fn()),
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string) =>
            method === "Accessibility.getFullAXTree" ? await tree.promise : {},
          detach,
        }),
      }),
    };
    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockImplementation(actual.withPageScopedCdpClient);
    vi.useFakeTimers();
    try {
      const promise = mod.snapshotAriaViaPlaywright({
        ...target,
        timeoutMs,
      });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(timeoutMs ?? 5_000);

      await expect(Promise.race([promise, Promise.resolve("still pending")])).rejects.toThrow(
        /Page CDP operation timed out/,
      );
      expect(detach).toHaveBeenCalledOnce();
      tree.resolve({ nodes: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures an empty ARIA snapshot with the default timeout", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = makeAriaSnapshotPage(ariaSnapshotMock);
    getPageForTargetId.mockResolvedValue(page);

    await mod.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refsMode: "aria",
      timeoutMs: Number.NaN,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 5000 });
  });

  it("rejects page-wide refs when a subframe navigates during capture", async () => {
    const mainFrame = { id: "main-frame" };
    const subframe = { id: "subframe" };
    const handlers = new Map<string, (frame: unknown) => void>();
    const page = {
      ariaSnapshot: vi.fn(async () => {
        handlers.get("framenavigated")?.(subframe);
        return '- button "Save"';
      }),
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, handler: (frame: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    getPageForTargetId.mockResolvedValue(page);

    await expect(
      mod.snapshotRoleViaPlaywright({
        ...target,
        refsMode: "aria",
      }),
    ).rejects.toThrow("Frame changed while its browser snapshot was being captured");

    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it("returns selector no-match snapshots without collecting URLs", async () => {
    const ariaSnapshot = vi.fn(async () => {
      throw new Error("ariaSnapshot should not run for a selector with no matches");
    });
    const locator = {
      count: vi.fn(async () => 0),
      ariaSnapshot,
    };
    const page = {
      locator: vi.fn(() => locator),
      mainFrame: vi.fn(() => ({ id: "main-frame" })),
      on: vi.fn(),
      off: vi.fn(),
      evaluate: vi.fn(async () => [{ text: "link", url: "https://example.test" }]),
    };
    getPageForTargetId.mockResolvedValue(page);

    const result = await mod.snapshotRoleViaPlaywright({
      ...target,
      selector: "#missing",
      urls: true,
    });

    expect(result.snapshot).toBe("(empty)");
    expect(result.snapshot).not.toContain("Links:");
    expect(locator.count).toHaveBeenCalledOnce();
    expect(ariaSnapshot).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("times out a stalled selector probe without publishing late refs", async () => {
    const pendingCount = createDeferred<number>();
    const ariaSnapshot = vi.fn(async () => '- button "Late"');
    const page = {
      ...makeAriaSnapshotPage(ariaSnapshot),
      locator: vi.fn(() => ({ count: () => pendingCount.promise, ariaSnapshot })),
    };
    getPageForTargetId.mockResolvedValue(page);
    vi.useFakeTimers();
    try {
      const promise = mod.snapshotRoleViaPlaywright({
        ...target,
        selector: "#present",
        timeoutMs: 750,
      });
      const rejected = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(750);
      await rejected;
      pendingCount.resolve(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ariaSnapshot).not.toHaveBeenCalled();
      expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
      expect(page.off).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the capture timeout between selector lookup and snapshot", async () => {
    const pendingCount = createDeferred<number>();
    const locator = makeNativeSnapshotLocator();
    const frame = { locator: () => ({ ...locator, count: () => pendingCount.promise }) };
    const page = {
      ...makeAriaSnapshotPage(vi.fn()),
      locator: () => ({
        elementHandle: async () => ({ contentFrame: async () => frame, dispose: async () => {} }),
      }),
    };
    getPageForTargetId.mockResolvedValue(page);
    vi.useFakeTimers();
    try {
      const promise = mod.snapshotRoleViaPlaywright({
        ...target,
        selector: "#present",
        frameSelector: "iframe#content",
        timeoutMs: 750,
      });
      await vi.advanceTimersByTimeAsync(500);
      pendingCount.resolve(1);
      await promise;
      expect(storeRoleRefsForTarget).toHaveBeenCalledWith(
        expect.objectContaining({ page, frame, frameSelector: "iframe#content" }),
      );
      expect(page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
      expect(locator.elementHandle).toHaveBeenCalledWith({ timeout: 250 });
      expect(withPageScopedCdpClient).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 250 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a native capture timeout without waiting for stalled handle disposal", async () => {
    const locator = makeNativeSnapshotLocator();
    const disposed = createDeferred<void>();
    const dispose = vi.fn(() => disposed.promise);
    locator.elementHandle.mockResolvedValueOnce({ dispose });
    getPageForTargetId.mockResolvedValue({
      ...makeAriaSnapshotPage(vi.fn()),
      locator: () => locator,
    });
    withPageScopedCdpClient.mockRejectedValueOnce(new Error("Page CDP operation timed out"));
    vi.useFakeTimers();
    let failure: unknown;
    const operation = mod
      .snapshotRoleViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        selector: "#present",
        timeoutMs: 500,
      })
      .catch((error: unknown) => {
        failure = error;
      });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("timed out");
      expect(dispose).toHaveBeenCalledOnce();
      expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
    } finally {
      disposed.resolve();
      await operation;
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out capture handle alive until late marker cleanup settles", async () => {
    const actual = await vi.importActual<typeof import("./pw-session.page-cdp.js")>(
      "./pw-session.page-cdp.js",
    );
    const locator = makeNativeSnapshotLocator();
    const injected = createDeferred<void>();
    let markerInstalled = false;
    let handleDisposed = false;
    const root = {
      dispose: vi.fn(async () => {
        handleDisposed = true;
      }),
      evaluate: vi
        .fn()
        .mockImplementationOnce(async () => {
          markerInstalled = true;
          await injected.promise;
        })
        .mockImplementation(async () => {
          if (handleDisposed) {
            throw new Error("Handle already disposed");
          }
          markerInstalled = false;
        }),
    };
    locator.elementHandle.mockResolvedValueOnce(root);
    getPageForTargetId.mockResolvedValue({
      ...makeAriaSnapshotPage(vi.fn()),
      locator: () => locator,
      context: () => ({
        newCDPSession: async () => ({
          send: async () => {
            throw new Error("Session detached");
          },
          detach: async () => {},
        }),
      }),
    });
    withPageScopedCdpClient.mockImplementation(actual.withPageScopedCdpClient);
    withCdpSnapshotRoot.mockImplementation(actual.withCdpSnapshotRoot);
    vi.useFakeTimers();
    let failure: unknown;
    const operation = mod
      .snapshotRoleViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        selector: "#present",
        timeoutMs: 500,
      })
      .catch((error: unknown) => {
        failure = error;
      });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(failure).toBeInstanceOf(Error);
      injected.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(markerInstalled).toBe(false);
      expect(root.dispose).toHaveBeenCalledOnce();
      expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
    } finally {
      injected.resolve();
      await operation;
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("rejects frame-scoped refs when their frame detaches during binding", async () => {
    const handlers = new Map<string, (frame: unknown) => void>();
    const locator = makeNativeSnapshotLocator();
    const frame = {
      id: "frame-1",
      locator: vi.fn(() => locator),
    };
    markBackendDomRefsOnPage.mockImplementationOnce(async () => {
      handlers.get("framedetached")?.(frame);
      return new Set(["e1"]);
    });
    const page = {
      locator: vi.fn(() => ({
        elementHandle: vi.fn(async () => ({
          contentFrame: vi.fn(async () => frame),
          dispose: vi.fn(async () => {}),
        })),
      })),
      on: vi.fn((eventName: string, handler: (frame: unknown) => void) => {
        handlers.set(eventName, handler);
      }),
      off: vi.fn(),
    };
    getPageForTargetId.mockResolvedValue(page);

    await expect(
      mod.snapshotRoleViaPlaywright({
        ...target,
        frameSelector: "iframe#content",
      }),
    ).rejects.toThrow("Frame changed while its browser snapshot was being captured");

    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
    expect(page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
    expect(page.off).toHaveBeenCalledWith("framedetached", expect.any(Function));
  });

  it("stores only complete refs after truncating ai snapshots", async () => {
    const first = '- button "Visible" [ref=e1]';
    const second = `- button "Hidden ${"X".repeat(100)} 🙂" [ref=e2]`;
    const marker = "[...TRUNCATED - page too large]";
    const ariaSnapshotMock = vi.fn().mockResolvedValue(`${first}\n${second}`);
    const page = makeAriaSnapshotPage(ariaSnapshotMock);
    getPageForTargetId.mockResolvedValue(page);

    const result = await mod.snapshotRoleViaPlaywright({
      refsMode: "aria",
      ...target,
      maxChars: first.length + 2 + marker.length,
    });

    expect(result.snapshot).toBe(`${first}\n\n${marker}`);
    expect(result.truncated).toBe(true);
    expect(result.refs).toEqual({ e1: { role: "button", name: "Visible" } });
    expect(storeRoleRefsForTarget).toHaveBeenLastCalledWith({
      page,
      ...target,
      refs: { e1: { role: "button", name: "Visible" } },
      mode: "aria",
    });
  });

  it("still rejects malformed AI names beyond the output budget", async () => {
    const ariaSnapshot = vi.fn(
      async () => '- button "Visible" [ref=e1]\n' + String.raw`- button "bad\uZZZZ" [ref=e2]`,
    );
    getPageForTargetId.mockResolvedValue(makeAriaSnapshotPage(ariaSnapshot));

    await expect(
      mod.snapshotRoleViaPlaywright({
        refsMode: "aria",
        cdpUrl: "http://127.0.0.1:9222",
        maxChars: 1,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it("rejects excessive viewport dimensions before calling Playwright", async () => {
    const page = { setViewportSize: vi.fn(async () => {}) };
    getPageForTargetId.mockResolvedValue(page);

    await expect(
      mod.resizeViewportViaPlaywright({
        ...target,
        width: Number.MAX_SAFE_INTEGER,
        height: 768,
      }),
    ).rejects.toThrow("viewport width exceeds maximum of 8192");

    expect(page.setViewportSize).not.toHaveBeenCalled();
  });

  it("publishes finalized CDP refs without recomputing duplicate indexes", async () => {
    const page = makeAriaSnapshotPage(vi.fn());

    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage.mockResolvedValue(new Set(["e2"]));
    readDocumentIdentitiesForPage.mockResolvedValue({ mainFrame: "cdp:loader-1" });

    await mod.storeSnapshotRefsViaPlaywright({
      ...target,
      expectedDocumentIdentity: "cdp:loader-1",
      refs: Object.freeze({
        e1: Object.freeze({ role: "button", name: "Save", nth: 0, backendDOMNodeId: 42 }),
        e2: Object.freeze({ role: "button", name: "Save", nth: 1, backendDOMNodeId: 84 }),
      }),
    });

    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      ...target,
      refs: {
        e1: { role: "button", name: "Save", nth: 0, domMarker: true },
        e2: { role: "button", name: "Save", nth: 1, domMarker: true },
      },
      mode: "role",
    });
  });

  it("does not publish CDP refs after the document changes", async () => {
    const page = makeAriaSnapshotPage(vi.fn());

    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage.mockResolvedValue(new Set(["e1"]));
    readDocumentIdentitiesForPage.mockResolvedValue({ mainFrame: "cdp:loader-2" });

    await expect(
      mod.storeSnapshotRefsViaPlaywright({
        ...target,
        expectedDocumentIdentity: "cdp:loader-1",
        refs: {
          e1: { role: "button", name: "Save", backendDOMNodeId: 42 },
        },
      }),
    ).rejects.toThrow("Frame changed while its browser snapshot refs were being published");

    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });
});
