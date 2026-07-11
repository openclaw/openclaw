// Browser tests cover pw tools core.snapshot plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPageForTargetId = vi.fn();
const ensurePageState = vi.fn();
const storeRoleRefsForTarget = vi.fn();
const withPageScopedCdpClient = vi.fn();
const markBackendDomRefsOnPage = vi.fn();
const formatAriaSnapshot = vi.fn();
const gotoPageWithNavigationGuard = vi.fn();
const assertBrowserDownloadSaveAllowed = vi.fn(async () => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const runGuardedPlaywrightPageAction = vi.fn(
  async <T>({ action }: { action: () => Promise<T> }): Promise<T> => await action(),
);
const createDownloadCaptureForPage = vi.fn(() => ({
  armed: true,
  promise: new Promise(() => {}),
  cancel: vi.fn(),
}));

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely: vi.fn(),
  closeBlockedNavigationTarget: vi.fn(),
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  isBrowserObservedDialogBlockedError: vi.fn(() => false),
  isDownloadStartingNavigationError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn(() => false),
  storeRoleRefsForTarget,
}));

vi.mock("./pw-download-capture.js", () => ({
  createDownloadCaptureForPage,
}));

vi.mock("./pw-interaction-navigation-guard.js", () => ({
  assertBrowserDownloadSaveAllowed,
  createAbortPromiseWithListener: (signal?: AbortSignal, onAbort?: () => void) => {
    if (!signal) {
      return { cleanup: () => {} };
    }
    let listener: (() => void) | undefined;
    const abortPromise = signal.aborted
      ? (() => {
          onAbort?.();
          return Promise.reject(signal.reason);
        })()
      : new Promise<never>((_, reject) => {
          listener = () => {
            onAbort?.();
            reject(signal.reason);
          };
          signal.addEventListener("abort", listener, { once: true });
        });
    void abortPromise.catch(() => {});
    return {
      abortPromise,
      cleanup: () => {
        if (listener) {
          signal.removeEventListener("abort", listener);
        }
      },
    };
  },
  runGuardedPlaywrightPageAction,
}));

vi.mock("./pw-session.page-cdp.js", () => ({
  markBackendDomRefsOnPage,
  withPageScopedCdpClient,
}));

vi.mock("./cdp.js", () => ({
  formatAriaSnapshot,
}));

type ScopedCdpClientOptions = {
  cdpUrl?: unknown;
  fn?: unknown;
  page?: unknown;
  targetId?: unknown;
};

function requireScopedCdpClientOptions(): ScopedCdpClientOptions {
  const [call] = withPageScopedCdpClient.mock.calls;
  if (!call) {
    throw new Error("expected scoped CDP client call");
  }
  const [options] = call;
  if (!options || typeof options !== "object") {
    throw new Error("expected scoped CDP client options");
  }
  return options as ScopedCdpClientOptions;
}

describe("pw-tools-core aria snapshot storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGuardedPlaywrightPageAction.mockImplementation(
      async <T>({ action }: { action: () => Promise<T> }): Promise<T> => await action(),
    );
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
    expect(withPageScopedCdpClient).toHaveBeenCalledTimes(1);
    const scopedClientOptions = requireScopedCdpClientOptions();
    expect(scopedClientOptions.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(scopedClientOptions.page).toBe(page);
    expect(scopedClientOptions.targetId).toBe("tab-1");
    expect(typeof scopedClientOptions.fn).toBe("function");
    expect(markBackendDomRefsOnPage).toHaveBeenCalledWith({
      page,
      refs: [{ ref: "ax1", backendDOMNodeId: 42 }],
    });
    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refs: {
        ax1: { role: "button", name: "OK", domMarker: true },
      },
      mode: "role",
    });
  });

  it("races snapshotAriaViaPlaywright against an explicit timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const page = { id: "page-1" };
      getPageForTargetId.mockResolvedValue(page);
      withPageScopedCdpClient.mockImplementation(() => new Promise(() => {}));

      const mod = await import("./pw-tools-core.snapshot.js");
      const promise = mod.snapshotAriaViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        timeoutMs: 750,
      });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(750);

      await expect(promise).rejects.toThrow(/Aria snapshot via Playwright timed out/);
      expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        ssrfPolicy: undefined,
        reason: "aria snapshot interrupted",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a stuck aria CDP session when a policy-guarded request aborts", async () => {
    const page = { id: "page-1" };
    const controller = new AbortController();
    const requestError = new Error("request aborted");
    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockImplementation(() => new Promise(() => {}));

    const mod = await import("./pw-tools-core.snapshot.js");
    const promise = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      timeoutMs: 5_000,
      signal: controller.signal,
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    void promise.catch(() => {});
    controller.abort(requestError);

    await expect(promise).rejects.toBe(requestError);
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
      reason: "aria snapshot interrupted",
    });
  });

  it("uses the default aria node limit for non-finite limits", async () => {
    const page = { id: "page-1" };
    const rawNodes = [{ nodeId: "1" }];
    const formattedNodes = [{ ref: "ax1", role: "document", name: "", depth: 0 }];

    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      limit: Number.NaN,
    });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(formatAriaSnapshot).toHaveBeenCalledWith(rawNodes, 500);
  });

  it("forwards an explicit timeoutMs into the role-aria Playwright ariaSnapshot call", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refsMode: "aria",
      timeoutMs: 8888,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 8888 });
  });

  it("uses the default snapshot timeout for non-finite role-aria timeouts", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refsMode: "aria",
      timeoutMs: Number.NaN,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 5000 });
  });

  it("uses the default snapshot timeout for non-finite ai snapshot timeouts", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      timeoutMs: Number.NaN,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 5000 });
  });

  it("does not split a surrogate pair when truncating ai snapshots", async () => {
    const prefix = `- button "${"A".repeat(18)}`;
    const ariaSnapshotMock = vi.fn().mockResolvedValue(`${prefix}🙂"`);
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      maxChars: prefix.length + 1,
    });

    expect(result.snapshot).toBe(`${prefix}\n\n[...TRUNCATED - page too large]`);
    expect(result.truncated).toBe(true);
  });

  it("threads explicit proxy policy and abort ownership through AI snapshots", async () => {
    const ctrl = new AbortController();
    const ariaSnapshot = vi.fn(async () => "");
    const page = { ariaSnapshot };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      browserProxyMode: "explicit-browser-proxy",
      signal: ctrl.signal,
    });

    expect(runGuardedPlaywrightPageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:9222",
        page,
        targetId: "tab-1",
        browserProxyMode: "explicit-browser-proxy",
        signal: ctrl.signal,
        action: expect.any(Function),
      }),
    );
    expect(ariaSnapshot).toHaveBeenCalledOnce();
  });

  it("guards PDF print lifecycle hooks with the snapshot navigation policy", async () => {
    const ctrl = new AbortController();
    const pdf = vi.fn(async () => Buffer.from("pdf"));
    const page = { pdf };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.pdfViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    expect(result.buffer.toString()).toBe("pdf");
    expect(runGuardedPlaywrightPageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        signal: ctrl.signal,
        action: expect.any(Function),
      }),
    );
    expect(pdf).toHaveBeenCalledWith({ printBackground: true });
  });

  it("retires a stuck policy-guarded PDF operation when its request aborts", async () => {
    const controller = new AbortController();
    const retired = new Error("Playwright connection retired");
    let rejectPdf!: (error: Error) => void;
    const pdf = vi.fn(
      () =>
        new Promise<Buffer>((_, reject) => {
          rejectPdf = reject;
        }),
    );
    const page = { pdf };
    getPageForTargetId.mockResolvedValue(page);
    forceDisconnectPlaywrightForTarget.mockImplementationOnce(async () => {
      rejectPdf(retired);
    });

    const mod = await import("./pw-tools-core.snapshot.js");
    const promise = mod.pdfViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: controller.signal,
    });
    void promise.catch(() => {});
    await vi.waitFor(() => expect(pdf).toHaveBeenCalledOnce());
    controller.abort(new Error("request aborted"));

    await expect(promise).rejects.toBe(retired);
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
      reason: "pdf generation aborted",
    });
  });

  it("uses the default navigation timeout for non-finite timeouts", async () => {
    const page = { url: vi.fn(() => "http://127.0.0.1:31337/after") };
    getPageForTargetId.mockResolvedValue(page);
    gotoPageWithNavigationGuard.mockResolvedValue(null);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      url: "http://127.0.0.1:31337/",
      timeoutMs: Number.NaN,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: "http://127.0.0.1:31337/after" });
    expect(gotoPageWithNavigationGuard).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("stores role fallback metadata when backend markers are unavailable", async () => {
    const page = { id: "page-1" };
    const mod = await import("./pw-tools-core.snapshot.js");

    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage.mockResolvedValue(new Set());

    await mod.storeAriaSnapshotRefsViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      nodes: [
        { ref: "ax1", role: "Button", name: "OK", backendDOMNodeId: 42, depth: 0 },
        { ref: "ax2", role: "Button", name: "OK", backendDOMNodeId: 84, depth: 0 },
      ],
    });

    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refs: {
        ax1: { role: "button", name: "OK" },
        ax2: { role: "button", name: "OK", nth: 1 },
      },
      mode: "role",
    });
  });
});
