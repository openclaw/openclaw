// Browser tests cover pw tools core ssrf guard plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  closeBlockedNavigationTarget: vi.fn(async () => {}),
  ensurePageState: vi.fn(() => ({})),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  finalizePendingBrowserInteractionAction: vi.fn<
    typeof import("./pw-session.js").finalizePendingBrowserInteractionAction
  >((error) => ({
    error: error instanceof Error ? error : new Error("pending interaction failed"),
    deferred: false,
  })),
  getPageForTargetId: vi.fn(async () => {
    if (!pageState.page) {
      throw new Error("missing page");
    }
    return pageState.page;
  }),
  gotoPageWithNavigationGuard: vi.fn(async () => null),
  isBrowserObservedDialogBlockedError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn<typeof import("./pw-session.js").isPolicyDenyNavigationError>(
    () => false,
  ),
  markObservedDialogsHandledRemotelyForPage: vi.fn(() => ({})),
  quarantineBlockedNavigationTarget: vi.fn(async () => {}),
  quarantineBlockedNavigationTargetForError: vi.fn(async () => {}),
  refLocator: vi.fn(() => {
    if (!pageState.locator) {
      throw new Error("missing locator");
    }
    return pageState.locator;
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
  trackPendingBrowserInteractionAction: vi.fn(
    (err: unknown, actionPromise: Promise<unknown>, onActionResolved?: () => void) => {
      void actionPromise.then(onActionResolved, () => {});
      return err instanceof Error ? err : new Error("aborted");
    },
  ),
  replacePendingBrowserInteractionActionError: vi.fn((_current: unknown, replacement: unknown) =>
    replacement instanceof Error ? replacement : new Error("replacement error"),
  ),
  withPageNavigationRequestGuard: vi.fn(
    async <T>({ action }: { action: () => Promise<T> }): Promise<T> => await action(),
  ),
  wasBrowserNavigationRequestBlockedBeforeDispatch: vi.fn(() => false),
}));

const pageCdpMocks = vi.hoisted(() => ({
  markBackendDomRefsOnPage: vi.fn(async () => new Set<string>()),
  withPageScopedCdpClient: vi.fn(
    async ({ fn }: { fn: (send: () => Promise<unknown>) => unknown }) =>
      await fn(async () => ({ nodes: [] })),
  ),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./pw-session.page-cdp.js", () => pageCdpMocks);

const interactions = await import("./pw-tools-core.interactions.js");
const snapshots = await import("./pw-tools-core.snapshot.js");

type SnapshotFrameListener = (frame: { url: () => string }) => void;

function createNavigationAwareSnapshotPage(initialUrl = "https://93.184.216.34/start") {
  let currentUrl = initialUrl;
  const listeners = new Set<SnapshotFrameListener>();
  const frame = { url: () => currentUrl };
  return {
    navigate(url: string) {
      currentUrl = url;
      for (const listener of listeners) {
        listener(frame);
      }
    },
    page: {
      url: vi.fn(() => currentUrl),
      on: vi.fn((event: string, listener: SnapshotFrameListener) => {
        if (event === "framenavigated") {
          listeners.add(listener);
        }
      }),
      off: vi.fn((event: string, listener: SnapshotFrameListener) => {
        if (event === "framenavigated") {
          listeners.delete(listener);
        }
      }),
    },
  };
}

describe("pw-tools-core browser SSRF guards", () => {
  beforeEach(() => {
    pageState.page = null;
    pageState.locator = null;
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pageCdpMocks)) {
      fn.mockClear();
    }
  });

  it("re-checks click-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://93.184.216.34";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      click: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("preserves SSRF policy when aborting a pending click", async () => {
    const ctrl = new AbortController();
    let clickStarted: () => void = () => {};
    const clickStartedPromise = new Promise<void>((resolve) => {
      clickStarted = resolve;
    });
    const clickPending = new Promise<void>(() => {});
    pageState.page = { url: vi.fn(() => "about:blank") };
    pageState.locator = {
      click: vi.fn(() => {
        clickStarted();
        return clickPending;
      }),
    };

    const task = interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await clickStartedPromise;
    ctrl.abort(new Error("aborted by test"));

    await expect(task).rejects.toThrow("aborted by test");
    expect(sessionMocks.trackPendingBrowserInteractionAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: "aborted by test" }),
      clickPending,
      expect.any(Function),
    );
    expect(sessionMocks.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      reason: "click aborted",
    });
  });

  it("re-checks select-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://93.184.216.34";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      selectOption: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.selectOptionViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      values: ["go"],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("re-checks form fill-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://93.184.216.34";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      fill: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.fillFormViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      fields: [{ ref: "1", type: "text", value: "go" }],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("re-checks the current page before evaluating page content", async () => {
    const evaluate = vi.fn(async () => "ok");
    pageState.page = {
      evaluate,
      url: vi.fn(() => "https://93.184.216.34"),
    };

    await interactions.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      fn: "() => document.body.innerText",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
    expect(
      sessionMocks.assertPageNavigationCompletedSafely.mock.invocationCallOrder[0],
    ).toBeLessThan(evaluate.mock.invocationCallOrder[0]);
  });

  it("guards wait predicates that trigger navigation", async () => {
    let currentUrl = "https://93.184.216.34";
    const waitForFunction = vi.fn(async () => {
      currentUrl = "https://target.example";
    });
    pageState.page = {
      url: vi.fn(() => currentUrl),
      waitForFunction,
    };

    await interactions.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      fn: "() => true",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    );
    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      waitForFunction.mock.invocationCallOrder[0]!,
    );
    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("guards resize handlers that trigger navigation", async () => {
    let currentUrl = "https://93.184.216.34";
    const setViewportSize = vi.fn(async () => {
      currentUrl = "https://target.example";
    });
    pageState.page = {
      setViewportSize,
      url: vi.fn(() => currentUrl),
    };

    await interactions.resizeViewportViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      width: 800,
      height: 600,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    );
    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      setViewportSize.mock.invocationCallOrder[0]!,
    );
    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("preserves helper compatibility when no ssrfPolicy is provided", async () => {
    pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
    pageState.locator = { click: vi.fn(async () => {}) };

    await interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      // no ssrfPolicy: direct helper callers keep previous compatibility semantics
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
  });

  it("re-checks batched click-triggered navigations with the session safety helper", async () => {
    let currentUrl = "https://93.184.216.34";
    pageState.page = { url: vi.fn(() => currentUrl) };
    pageState.locator = {
      click: vi.fn(async () => {
        currentUrl = "https://target.example";
      }),
    };

    await interactions.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      actions: [{ kind: "click", ref: "1" }],
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: pageState.page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "tab-1",
    });
  });

  it("keeps highlight disposal inside the navigation guard", async () => {
    vi.useFakeTimers();
    try {
      let guardActive = false;
      let disposalSawGuard = false;
      sessionMocks.withPageNavigationRequestGuard.mockImplementationOnce(
        async ({ action }: { action: () => Promise<unknown> }) => {
          guardActive = true;
          try {
            return await action();
          } finally {
            guardActive = false;
          }
        },
      );
      const dispose = vi.fn(async () => {
        disposalSawGuard = guardActive;
      });
      const highlight = vi.fn(async () => ({ dispose }));
      pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
      pageState.locator = { highlight };

      const task = interactions.highlightViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ref: "1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(highlight).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(dispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(250);
      await task;
      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          page: pageState.page,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      );
      expect(disposalSawGuard).toBe(true);
      expect(guardActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "hover",
      run: () =>
        interactions.hoverViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      method: "hover",
    },
    {
      name: "scrollIntoView",
      run: () =>
        interactions.scrollIntoViewViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          ref: "1",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      method: "scrollIntoViewIfNeeded",
    },
    {
      name: "drag",
      run: () =>
        interactions.dragViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "tab-1",
          startRef: "1",
          endRef: "2",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      method: "dragTo",
    },
  ])("guards direct $name actions with the supplied SSRF policy", async ({ run, method }) => {
    const locator = {
      hover: vi.fn(async () => {}),
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      dragTo: vi.fn(async () => {}),
    };
    pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
    pageState.locator = locator;

    await run();

    expect(locator[method as keyof typeof locator]).toHaveBeenCalledTimes(1);
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: pageState.page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    );
  });

  it("retires the cached Playwright connection after guard cleanup fails", async () => {
    pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
    pageState.locator = { hover: vi.fn(async () => {}) };

    await interactions.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ref: "1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });

    const guardOpts = sessionMocks.withPageNavigationRequestGuard.mock.calls.at(-1)?.[0] as {
      onGuardCleanupError?: (err: unknown) => Promise<void>;
    };
    await guardOpts.onGuardCleanupError?.(new Error("route cleanup failed"));

    expect(sessionMocks.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      reason: "navigation guard cleanup failed",
    });
  });

  it("preserves SSRF policy through recursively nested hover, scroll, and drag batches", async () => {
    const locator = {
      hover: vi.fn(async () => {}),
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      dragTo: vi.fn(async () => {}),
    };
    pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
    pageState.locator = locator;

    const result = await interactions.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      actions: [
        {
          kind: "batch",
          actions: [
            { kind: "hover", ref: "1" },
            { kind: "scrollIntoView", ref: "1" },
            { kind: "drag", startRef: "1", endRef: "2" },
          ],
        },
      ],
    });

    expect(result.results).toEqual([{ ok: true }]);
    expect(locator.hover).toHaveBeenCalledTimes(1);
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(locator.dragTo).toHaveBeenCalledTimes(1);
    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledTimes(3);
    for (const [guardOpts] of sessionMocks.withPageNavigationRequestGuard.mock.calls) {
      expect(guardOpts).toEqual(
        expect.objectContaining({
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      );
    }
  });

  it("preserves explicit proxy mode through the real nested batch executor", async () => {
    const locator = {
      hover: vi.fn(async () => {}),
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      dragTo: vi.fn(async () => {}),
    };
    pageState.page = { url: vi.fn(() => "about:blank") };
    pageState.locator = locator;

    await interactions.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      browserProxyMode: "explicit-browser-proxy",
      actions: [
        {
          kind: "batch",
          actions: [
            { kind: "hover", ref: "1" },
            { kind: "scrollIntoView", ref: "1" },
            { kind: "drag", startRef: "1", endRef: "2" },
          ],
        },
      ],
    });

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledTimes(3);
    for (const [guardOpts] of sessionMocks.withPageNavigationRequestGuard.mock.calls) {
      expect(guardOpts).toEqual(
        expect.objectContaining({ browserProxyMode: "explicit-browser-proxy" }),
      );
    }
  });

  it("quarantines a policy denial when the request could not be stopped before dispatch", async () => {
    const blocked = new Error("blocked after route abort failed");
    blocked.name = "SsrFBlockedError";
    pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
    pageState.locator = { hover: vi.fn(async () => {}) };
    sessionMocks.withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);
    sessionMocks.isPolicyDenyNavigationError.mockReturnValueOnce(true);
    sessionMocks.wasBrowserNavigationRequestBlockedBeforeDispatch.mockReturnValueOnce(false);

    await expect(
      interactions.hoverViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ref: "1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toThrow("blocked after route abort failed");

    expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      error: blocked,
      page: pageState.page,
      targetId: "tab-1",
    });
  });

  it("keeps the source page usable when Playwright stopped the denied request", async () => {
    const blocked = new Error("blocked before dispatch");
    blocked.name = "SsrFBlockedError";
    pageState.page = { url: vi.fn(() => "https://93.184.216.34") };
    pageState.locator = { hover: vi.fn(async () => {}) };
    sessionMocks.withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);
    sessionMocks.isPolicyDenyNavigationError.mockReturnValueOnce(true);
    sessionMocks.wasBrowserNavigationRequestBlockedBeforeDispatch.mockReturnValueOnce(true);

    await expect(
      interactions.hoverViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ref: "1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toThrow("blocked before dispatch");

    expect(sessionMocks.quarantineBlockedNavigationTargetForError).not.toHaveBeenCalled();
  });

  it("re-checks current page URL before snapshotting AI content", async () => {
    const ariaSnapshot = vi.fn(async () => 'button "Save"');
    pageState.page = {
      ariaSnapshot,
      url: vi.fn(() => "https://93.184.216.34"),
    };

    await snapshots.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
        action: expect.any(Function),
      }),
    );
    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      ariaSnapshot.mock.invocationCallOrder[0],
    );
  });

  it("re-checks current page URL before role snapshots", async () => {
    const ariaSnapshot = vi.fn(async () => "");
    pageState.page = {
      locator: vi.fn(() => ({ ariaSnapshot })),
      url: vi.fn(() => "https://93.184.216.34"),
    };

    await snapshots.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
        action: expect.any(Function),
      }),
    );
    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      ariaSnapshot.mock.invocationCallOrder[0],
    );
  });

  it("re-checks current page URL before aria snapshots", async () => {
    pageState.page = {
      url: vi.fn(() => "https://93.184.216.34"),
    };

    await snapshots.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
        action: expect.any(Function),
      }),
    );
    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      pageCdpMocks.withPageScopedCdpClient.mock.invocationCallOrder[0],
    );
    expect(sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      pageCdpMocks.markBackendDomRefsOnPage.mock.invocationCallOrder[0],
    );
  });

  it("keeps aria ref-marker DOM mutations inside the full navigation window", async () => {
    vi.useFakeTimers();
    try {
      const navigation = createNavigationAwareSnapshotPage();
      pageState.page = navigation.page;
      pageCdpMocks.markBackendDomRefsOnPage.mockImplementationOnce(async () => {
        navigation.navigate("http://127.0.0.1/private");
        return new Set<string>();
      });
      sessionMocks.isPolicyDenyNavigationError.mockImplementation(
        (err: unknown) =>
          err instanceof Error &&
          (err.name === "SsrFBlockedError" || err.name === "InvalidBrowserNavigationUrlError"),
      );

      const task = snapshots.snapshotAriaViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow(/blocked/i);

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
      expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith(
        expect.objectContaining({ page: navigation.page, targetId: "tab-1" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards PDF beforeprint hooks that navigate", async () => {
    vi.useFakeTimers();
    try {
      const navigation = createNavigationAwareSnapshotPage();
      const pdf = vi.fn(async () => {
        navigation.navigate("http://127.0.0.1/private");
        return Buffer.from("blocked");
      });
      pageState.page = { ...navigation.page, pdf };
      sessionMocks.isPolicyDenyNavigationError.mockImplementation(
        (err: unknown) =>
          err instanceof Error &&
          (err.name === "SsrFBlockedError" || err.name === "InvalidBrowserNavigationUrlError"),
      );

      const task = snapshots.pdfViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow(/blocked/i);

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(pdf).toHaveBeenCalledWith({ printBackground: true });
      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
