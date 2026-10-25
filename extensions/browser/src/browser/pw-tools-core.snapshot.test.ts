import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeTimers } from "./pw-tools-core.guard-test-support.js";

const getPage = vi.fn();
const ensurePageState = vi.fn(() => ({}));
const publishRefs = vi.fn();
const pageCdp = vi.fn();
const withCdpSnapshotRoot = vi.fn();
const snapshotRoleViaCdpSession = vi.fn();
const bindRefs = vi.fn();
const readDocumentIdentitiesForPage = vi.fn();
const formatAriaSnapshot = vi.fn();
const gotoPageWithNavigationGuard = vi.fn();
const createDownloadCaptureForPage = vi.fn(() => ({
  armed: true,
  promise: new Promise(() => {}),
  cancel: vi.fn(),
}));

// mock-isolation: Snapshot fixtures own page state and references instead of a live browser session.
vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely: vi.fn(),
  closeBlockedNavigationTarget: vi.fn(),
  ensurePageState,
  forceDisconnectPlaywrightForTarget: vi.fn(),
  getPageForTargetId: getPage,
  gotoPageWithNavigationGuard,
  isDownloadStartingNavigationError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn(() => false),
  storeRoleRefsForTarget: publishRefs,
}));

vi.mock("./pw-download-capture.js", () => ({
  createDownloadCaptureForPage,
}));

vi.mock("./pw-session.page-cdp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session.page-cdp.js")>()),
  markBackendDomRefsOnPage: bindRefs,
  readDocumentIdentitiesForPage,
  withPageScopedCdpClient: pageCdp,
  withCdpSnapshotRoot,
}));

vi.mock("./cdp-role-snapshot.js", () => ({ snapshotRoleViaCdpSession }));

vi.mock("./cdp.js", () => ({
  formatAriaSnapshot,
}));

function makePage<T extends Record<string, unknown>>(overrides: T) {
  const mainFrame = { id: "main-frame" };
  const page = {
    mainFrame: () => mainFrame,
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
  getPage.mockResolvedValue(page);
  return page;
}
function makeAriaSnapshotPage(ariaSnapshot = vi.fn()) {
  return makePage({ ariaSnapshot });
}
function frameElement(frame: object) {
  return {
    elementHandle: vi.fn(async () => ({
      contentFrame: async () => frame,
      dispose: async () => {},
    })),
  };
}

function makeNativeSnapshotLocator() {
  const capture = {
    snapshot: '- button "Save" [ref=e1]',
    refs: { e1: { role: "button", name: "Save", backendDOMNodeId: 42 } },
    stats: { lines: 1, chars: 29, refs: 1, interactive: 1 },
  };
  snapshotRoleViaCdpSession.mockResolvedValue(capture);
  pageCdp.mockImplementation(async ({ fn }) => await fn(vi.fn()));
  withCdpSnapshotRoot.mockImplementation(async ({ run }) => await run(42));
  bindRefs.mockResolvedValue(new Set(["e1"]));
  return {
    count: vi.fn(async () => 1),
    elementHandle: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
  };
}

const mod = await import("./pw-tools-core.snapshot.js");

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };
function snapshot(options: Omit<Parameters<typeof mod.snapshotRoleViaPlaywright>[0], "cdpUrl">) {
  return mod.snapshotRoleViaPlaywright({ cdpUrl: target.cdpUrl, ...options });
}
function captureFailure() {
  let failure: unknown;
  const operation = snapshot({ selector: "#present", timeoutMs: 500 }).catch((error: unknown) => {
    failure = error;
  });
  return { operation, error: () => failure };
}

describe("pw-tools-core aria snapshot storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the resolved page when storing aria refs", async () => {
    const page = makeAriaSnapshotPage();
    const rawNodes = [{ backendDOMNodeId: 42 }];
    const formattedNodes = [
      { ref: "ax1", role: "Button", name: "OK", backendDOMNodeId: 42, depth: 0 },
      { ref: "ax2", role: "Button", name: "OK", backendDOMNodeId: 84, depth: 0 },
      { ref: "ax3", role: "Button", name: "", depth: 0 },
    ];

    pageCdp.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);
    bindRefs.mockResolvedValue(new Set());

    const result = await mod.snapshotAriaViaPlaywright({ ...target, limit: 5 });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(ensurePageState).toHaveBeenCalledWith(page);
    expect(pageCdp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page, fn: expect.any(Function) }),
    );
    expect(bindRefs).toHaveBeenCalledWith({
      page,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
      assertCurrent: expect.any(Function),
    });
    expect(publishRefs).toHaveBeenCalledWith({
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
    makeAriaSnapshotPage();
    bindRefs.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return new Set();
    });
    const pending = mod.storeSnapshotRefsViaPlaywright({
      ...target,
      signal: controller.signal,
      refs: { e1: { role: "button", name: "Cancelled" } },
    });
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    await expect(pending).rejects.toBe(reason);
    expect(publishRefs).not.toHaveBeenCalled();
  });

  it("bounds a stalled ARIA snapshot with timeoutMs=750", async () => {
    const timeoutMs = 750;
    const actual = await vi.importActual<typeof import("./pw-session.page-cdp.js")>(
      "./pw-session.page-cdp.js",
    );
    const tree = createDeferred<{ nodes: [] }>();
    const detach = vi.fn(async () => {});
    makePage({
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string) =>
            method === "Accessibility.getFullAXTree" ? await tree.promise : {},
          detach,
        }),
      }),
    });
    pageCdp.mockImplementation(actual.withPageScopedCdpClient);
    await withFakeTimers(async () => {
      const promise = mod.snapshotAriaViaPlaywright({ ...target, timeoutMs });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(timeoutMs);

      await expect(Promise.race([promise, Promise.resolve("still pending")])).rejects.toThrow(
        /Page CDP operation timed out/,
      );
      expect(detach).toHaveBeenCalledOnce();
      tree.resolve({ nodes: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(publishRefs).not.toHaveBeenCalled();
    });
  });

  it("captures an empty ARIA snapshot with the default timeout", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    makeAriaSnapshotPage(ariaSnapshotMock);

    await snapshot({
      targetId: target.targetId,
      refsMode: "aria",
      timeoutMs: Number.NaN,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 5000 });
  });

  it.each([false, true])(
    "rejects refs when their frame changes (frame-scoped=%s)",
    async (scoped) => {
      const handlers = new Map<string, (frame: unknown) => void>();
      const frame = { locator: () => makeNativeSnapshotLocator() };
      const emit = () => handlers.get(scoped ? "framedetached" : "framenavigated")?.(frame);
      const page = makePage({
        ariaSnapshot: vi.fn(async () => {
          emit();
          return '- button "Save"';
        }),
        locator: () => frameElement(frame),
        on: vi.fn((event: string, handler: (frame: unknown) => void) => {
          handlers.set(event, handler);
        }),
      });
      if (scoped) {
        bindRefs.mockImplementationOnce(async () => {
          emit();
          return new Set(["e1"]);
        });
      }
      await expect(
        snapshot({
          targetId: target.targetId,
          frameSelector: scoped ? "iframe#content" : undefined,
          refsMode: scoped ? undefined : "aria",
        }),
      ).rejects.toThrow("Frame changed while its browser snapshot was being captured");

      expect(publishRefs).not.toHaveBeenCalled();
      if (scoped) {
        expect(page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
        expect(page.off).toHaveBeenCalledWith("framedetached", expect.any(Function));
      }
    },
  );

  it("returns selector no-match snapshots without collecting URLs", async () => {
    const ariaSnapshot = vi.fn(async () => {
      throw new Error("ariaSnapshot should not run for a selector with no matches");
    });
    const locator = {
      count: vi.fn(async () => 0),
      ariaSnapshot,
    };
    const page = makePage({
      locator: vi.fn(() => locator),
      evaluate: vi.fn(async () => [{ text: "link", url: "https://example.test" }]),
    });

    const result = await snapshot({ targetId: target.targetId, selector: "#missing", urls: true });

    expect(result.snapshot).toBe("(empty)");
    expect(result.snapshot).not.toContain("Links:");
    expect(locator.count).toHaveBeenCalledOnce();
    expect(ariaSnapshot).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(publishRefs).toHaveBeenCalledExactlyOnceWith({
      page,
      ...target,
      refs: {},
      mode: "role",
    });
  });

  it("times out a stalled selector probe without publishing late refs", async () => {
    const pendingCount = createDeferred<number>();
    const ariaSnapshot = vi.fn(async () => '- button "Late"');
    const page = makePage({
      ariaSnapshot,
      locator: vi.fn(() => ({ count: () => pendingCount.promise, ariaSnapshot })),
    });
    await withFakeTimers(async () => {
      const promise = snapshot({ targetId: target.targetId, selector: "#present", timeoutMs: 750 });
      const rejected = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(750);
      await rejected;
      pendingCount.resolve(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ariaSnapshot).not.toHaveBeenCalled();
      expect(publishRefs).not.toHaveBeenCalled();
      expect(page.off).toHaveBeenCalledTimes(2);
    });
  });

  it("shares the capture timeout between selector lookup and snapshot", async () => {
    const pendingCount = createDeferred<number>();
    const locator = makeNativeSnapshotLocator();
    const frame = { locator: () => ({ ...locator, count: () => pendingCount.promise }) };
    const page = makePage({ locator: () => frameElement(frame) });
    await withFakeTimers(async () => {
      const promise = snapshot({
        ...target,
        selector: "#present",
        frameSelector: "iframe#content",
        timeoutMs: 750,
      });
      await vi.advanceTimersByTimeAsync(500);
      pendingCount.resolve(1);
      await promise;
      expect(publishRefs).toHaveBeenCalledWith(
        expect.objectContaining({ page, frame, frameSelector: "iframe#content" }),
      );
      expect(page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
      expect(locator.elementHandle).toHaveBeenCalledWith({ timeout: 250 });
      expect(pageCdp).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 250 }));
    });
  });

  it.each([false, true])(
    "bounds capture without disposing before cleanup (late marker=%s)",
    async (lateMarker) => {
      const locator = makeNativeSnapshotLocator();
      const injected = createDeferred<void>();
      let markerInstalled = false;
      let handleDisposed = false;
      const root = {
        dispose: vi.fn(async () => {
          if (lateMarker) {
            handleDisposed = true;
          } else {
            await injected.promise;
          }
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
      const context = () => ({
        newCDPSession: async () => ({
          send: async () => {
            throw new Error("Session detached");
          },
          detach: async () => {},
        }),
      });
      makePage({ locator: () => locator, ...(lateMarker && { context }) });
      if (lateMarker) {
        const actual = await vi.importActual<typeof import("./pw-session.page-cdp.js")>(
          "./pw-session.page-cdp.js",
        );
        pageCdp.mockImplementation(actual.withPageScopedCdpClient);
        withCdpSnapshotRoot.mockImplementation(actual.withCdpSnapshotRoot);
      } else {
        pageCdp.mockRejectedValueOnce(new Error("Page CDP operation timed out"));
      }
      await withFakeTimers(async () => {
        const failure = captureFailure();
        try {
          await vi.advanceTimersByTimeAsync(lateMarker ? 500 : 0);
          expect(failure.error()).toBeInstanceOf(Error);
          if (lateMarker) {
            injected.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(markerInstalled).toBe(false);
          } else {
            expect(String(failure.error())).toContain("timed out");
          }
          expect(root.dispose).toHaveBeenCalledOnce();
          expect(publishRefs).not.toHaveBeenCalled();
        } finally {
          injected.resolve();
          await failure.operation;
          if (lateMarker) {
            await vi.advanceTimersByTimeAsync(0);
          }
        }
      });
    },
  );

  it("stores only complete refs after truncating ai snapshots", async () => {
    const first = '- button "Visible" [ref=e1]';
    const second = `- button "Hidden ${"X".repeat(100)} 🙂" [ref=e2]`;
    const marker = "[...TRUNCATED - page too large]";
    const ariaSnapshotMock = vi.fn().mockResolvedValue(`${first}\n${second}`);
    const page = makeAriaSnapshotPage(ariaSnapshotMock);

    const result = await snapshot({
      refsMode: "aria",
      ...target,
      maxChars: first.length + 2 + marker.length,
    });

    expect(result).toMatchObject({ snapshot: `${first}\n\n${marker}`, truncated: true });
    expect(result.refs).toEqual({ e1: { role: "button", name: "Visible" } });
    expect(publishRefs).toHaveBeenLastCalledWith({
      page,
      ...target,
      refs: { e1: { role: "button", name: "Visible" } },
      mode: "aria",
    });
  });

  it("rejects excessive viewport dimensions before calling Playwright", async () => {
    const page = makePage({ setViewportSize: vi.fn(async () => {}) });

    await expect(
      mod.resizeViewportViaPlaywright({
        ...target,
        width: Number.MAX_SAFE_INTEGER,
        height: 768,
      }),
    ).rejects.toThrow("viewport width exceeds maximum of 8192");

    expect(page.setViewportSize).not.toHaveBeenCalled();
  });

  it("does not publish CDP refs after the document changes", async () => {
    makeAriaSnapshotPage();
    bindRefs.mockResolvedValue(new Set(["e1"]));
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

    expect(publishRefs).not.toHaveBeenCalled();
  });
});
