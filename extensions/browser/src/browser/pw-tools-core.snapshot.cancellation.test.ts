// Browser tests cover pw tools core.snapshot plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPageForTargetId = vi.fn();
const ensurePageState = vi.fn();
const invalidateRoleRefsForTarget = vi.fn();
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const storeRoleRefsForTarget = vi.fn();
const withPageScopedCdpClient = vi.fn();
const markBackendDomRefsOnPage = vi.fn();
const formatAriaSnapshot = vi.fn();
const gotoPageWithNavigationGuard = vi.fn();
const createDownloadCaptureForPage = vi.fn(() => ({
  armed: true,
  promise: new Promise(() => {}),
  cancel: vi.fn(),
}));

type ScopedCdpSend = (method: string, params?: unknown) => Promise<unknown>;

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely: vi.fn(),
  closeBlockedNavigationTarget: vi.fn(),
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  invalidateRoleRefsForTarget,
  isDownloadStartingNavigationError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn(() => false),
  normalizeCdpUrl: vi.fn((raw: string) => raw.replace(/\/$/, "")),
  storeRoleRefsForTarget,
}));

vi.mock("./pw-download-capture.js", () => ({
  createDownloadCaptureForPage,
}));

vi.mock("./pw-session.page-cdp.js", () => ({
  markBackendDomRefsOnPage,
  withPageScopedCdpClient,
}));

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

function makeSnapshotPage(id = "page-1") {
  return {
    id,
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe("pw-tools-core snapshot cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures aria nodes without publishing refs or DOM markers", async () => {
    const page = makeSnapshotPage();
    const rawNodes = [{ backendDOMNodeId: 42 }];
    const formattedNodes = [{ ref: "ax1", role: "button", name: "OK", backendDOMNodeId: 42 }];

    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.captureAriaSnapshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      limit: 5,
    });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(markBackendDomRefsOnPage).not.toHaveBeenCalled();
    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it("cancels a capture-only diagnostic without disconnecting the shared browser", async () => {
    vi.useFakeTimers();
    try {
      const page = makeSnapshotPage();
      let rejectEnable!: (reason: unknown) => void;
      const send = vi.fn<ScopedCdpSend>(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectEnable = reject;
          }),
      );
      getPageForTargetId.mockResolvedValue(page);
      withPageScopedCdpClient.mockImplementation(
        async (options: { fn: (send: ScopedCdpSend) => Promise<unknown> }) =>
          await options.fn(send),
      );

      const mod = await import("./pw-tools-core.snapshot.js");
      const promise = mod.captureAriaSnapshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        timeoutMs: 750,
      });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(750);

      await expect(promise).rejects.toThrow(
        /Aria snapshot via Playwright timed out.*targetId=tab-1.*Accessibility\.enable/,
      );
      expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();

      rejectEnable(new Error("page session detached"));
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a capture-only diagnostic budget below the normal 500ms floor", async () => {
    vi.useFakeTimers();
    try {
      const page = makeSnapshotPage();
      const send = vi.fn<ScopedCdpSend>(async () => await new Promise<never>(() => {}));
      getPageForTargetId.mockResolvedValue(page);
      withPageScopedCdpClient.mockImplementation(
        async (options: { fn: (send: ScopedCdpSend) => Promise<unknown> }) =>
          await options.fn(send),
      );

      const mod = await import("./pw-tools-core.snapshot.js");
      const promise = mod.captureAriaSnapshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        timeoutMs: 25,
      });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(24);
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(promise).rejects.toThrow(
        /Aria snapshot via Playwright timed out after 25ms.*targetId=tab-1.*Accessibility\.enable/,
      );
      expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("races snapshotAriaViaPlaywright against an explicit timeoutMs without disconnecting siblings", async () => {
    vi.useFakeTimers();
    try {
      const page = makeSnapshotPage();
      let rejectEnable!: (reason: unknown) => void;
      const send = vi.fn<ScopedCdpSend>(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectEnable = reject;
          }),
      );
      getPageForTargetId.mockResolvedValue(page);
      withPageScopedCdpClient.mockImplementation(
        async (options: { fn: (send: ScopedCdpSend) => Promise<unknown> }) =>
          await options.fn(send),
      );

      const mod = await import("./pw-tools-core.snapshot.js");
      const promise = mod.snapshotAriaViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        timeoutMs: 750,
      });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(750);

      await expect(promise).rejects.toThrow(
        /Aria snapshot via Playwright timed out.*targetId=tab-1.*Accessibility\.enable/,
      );
      expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();

      rejectEnable(new Error("page session detached"));
      await vi.runAllTimersAsync();
      expect(send).toHaveBeenCalledTimes(1);
      expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight aria snapshot without disconnecting the shared browser", async () => {
    const page = makeSnapshotPage();
    let rejectEnable!: (reason: unknown) => void;
    const send = vi.fn<ScopedCdpSend>(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectEnable = reject;
        }),
    );
    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockImplementation(
      async (options: { fn: (send: ScopedCdpSend) => Promise<unknown> }) => await options.fn(send),
    );
    const controller = new AbortController();
    const cancellation = new Error("snapshot request cancelled");

    const mod = await import("./pw-tools-core.snapshot.js");
    const promise = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
    });
    void promise.catch(() => {});
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    controller.abort(cancellation);

    await expect(promise).rejects.toBe(cancellation);
    expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    rejectEnable(new Error("page session detached"));
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a sibling tab snapshot alive when another tab is cancelled", async () => {
    const controller = new AbortController();
    const cancellation = new Error("tab-1 snapshot cancelled");
    const pages = new Map([
      ["tab-1", makeSnapshotPage()],
      ["tab-2", makeSnapshotPage("page-2")],
    ]);
    getPageForTargetId.mockImplementation(async ({ targetId }: { targetId: string }) =>
      pages.get(targetId),
    );
    let finishSibling!: (value: { nodes: Array<{ snapshot: string }> }) => void;
    withPageScopedCdpClient.mockImplementation(
      async (options: { signal?: AbortSignal; targetId?: string }) => {
        if (options.targetId === "tab-1") {
          return await new Promise<never>((_resolve, reject) => {
            const rejectOnAbort = () =>
              reject(
                options.signal?.reason instanceof Error
                  ? options.signal.reason
                  : new Error(String(options.signal?.reason ?? "aborted")),
              );
            options.signal?.addEventListener("abort", rejectOnAbort, { once: true });
          });
        }
        return await new Promise<{ nodes: Array<{ snapshot: string }> }>((resolve) => {
          finishSibling = resolve;
        });
      },
    );
    formatAriaSnapshot.mockImplementation((nodes: Array<{ snapshot?: string }>) => [
      { ref: "ax-sibling", role: "document", name: nodes[0]?.snapshot ?? "" },
    ]);
    markBackendDomRefsOnPage.mockResolvedValue(new Set());

    const mod = await import("./pw-tools-core.snapshot.js");
    const cancelled = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
    });
    const sibling = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-2",
    });
    void cancelled.catch(() => {});
    await vi.waitFor(() => expect(withPageScopedCdpClient).toHaveBeenCalledTimes(2));

    controller.abort(cancellation);
    await expect(cancelled).rejects.toBe(cancellation);
    expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();

    finishSibling({ nodes: [{ snapshot: "still alive" }] });
    await expect(sibling).resolves.toEqual({
      nodes: [{ ref: "ax-sibling", role: "document", name: "still alive" }],
    });
  });

  it("does not publish a timed-out raw snapshot after a newer retry succeeds", async () => {
    const page = makeSnapshotPage();
    const controller = new AbortController();
    let releaseFirstRaw!: () => void;
    const firstRaw = new Promise<void>((resolve) => {
      releaseFirstRaw = resolve;
    });
    let collectCount = 0;
    withPageScopedCdpClient.mockImplementation(async () => {
      collectCount += 1;
      if (collectCount === 1) {
        await firstRaw;
        return { nodes: [{ snapshot: "old" }] };
      }
      return { nodes: [{ snapshot: "new" }] };
    });
    formatAriaSnapshot.mockImplementation((nodes: Array<{ snapshot?: string }>) => [
      {
        ref: nodes[0]?.snapshot === "old" ? "ax-old" : "ax-new",
        role: "button",
        name: nodes[0]?.snapshot ?? "",
      },
    ]);
    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage.mockResolvedValue(new Set());

    const mod = await import("./pw-tools-core.snapshot.js");
    const first = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
    });
    void first.catch(() => {});
    await vi.waitFor(() => expect(withPageScopedCdpClient).toHaveBeenCalledTimes(1));
    controller.abort(new Error("first snapshot timed out"));
    await expect(first).rejects.toThrow("first snapshot timed out");

    await expect(
      mod.snapshotAriaViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
      }),
    ).resolves.toEqual({
      nodes: [{ ref: "ax-new", role: "button", name: "new" }],
    });
    releaseFirstRaw();
    await vi.waitFor(() => expect(formatAriaSnapshot).toHaveBeenCalledTimes(2));

    expect(storeRoleRefsForTarget).toHaveBeenCalledTimes(1);
    expect(storeRoleRefsForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ refs: { "ax-new": { role: "button", name: "new" } } }),
    );
  });

  it("keeps newer AI refs when an older queued raw publication aborts", async () => {
    const mainFrame = { id: "main-frame" };
    const page = {
      ariaSnapshot: vi.fn(async () => '- button "AI" [ref=e2]'),
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
    };
    let releaseFirstMarker!: () => void;
    const firstMarker = new Promise<void>((resolve) => {
      releaseFirstMarker = resolve;
    });
    const secondMarker = new Promise<Set<string>>(() => {});
    let markerCall = 0;
    let publishedRefs: Record<string, unknown> | undefined;
    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: [{ snapshot: "raw" }] });
    formatAriaSnapshot.mockReturnValue([{ ref: "ax-raw", role: "button", name: "raw" }]);
    markBackendDomRefsOnPage
      .mockImplementationOnce(async () => {
        markerCall += 1;
        await firstMarker;
        return new Set();
      })
      .mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
        markerCall += 1;
        return await Promise.race([
          secondMarker,
          new Promise<never>((_resolve, reject) => {
            opts.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  opts.signal?.reason instanceof Error
                    ? opts.signal.reason
                    : new Error(String(opts.signal?.reason ?? "aborted")),
                ),
              { once: true },
            );
          }),
        ]);
      });
    invalidateRoleRefsForTarget.mockImplementation(() => {
      publishedRefs = undefined;
    });
    storeRoleRefsForTarget.mockImplementation((opts: { refs: Record<string, unknown> }) => {
      publishedRefs = opts.refs;
    });

    const controller = new AbortController();
    const mod = await import("./pw-tools-core.snapshot.js");
    const first = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
    await vi.waitFor(() => expect(markerCall).toBe(1));
    const second = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(withPageScopedCdpClient).toHaveBeenCalledTimes(2));

    const ai = mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });

    releaseFirstMarker();
    await vi.waitFor(() => expect(markerCall).toBe(2));
    controller.abort(new Error("queued raw publication timed out"));
    await expect(second).rejects.toThrow("queued raw publication timed out");
    await expect(first).resolves.toBeDefined();
    await expect(ai).resolves.toMatchObject({ refs: { e2: { role: "button", name: "AI" } } });
    expect(publishedRefs).toEqual({ e2: { role: "button", name: "AI" } });
  });

  it.each(["ai", "role"] as const)(
    "bounds queued %s ref publication by the snapshot deadline",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const page = makeAriaSnapshotPage(vi.fn(async () => '- button "Queued" [ref=e2]'));
        let releaseMarker!: () => void;
        const markerGate = new Promise<void>((resolve) => {
          releaseMarker = resolve;
        });
        getPageForTargetId.mockResolvedValue(page);
        markBackendDomRefsOnPage.mockImplementationOnce(async () => {
          await markerGate;
          return new Set();
        });

        const mod = await import("./pw-tools-core.snapshot.js");
        const blocker = mod.storeAriaSnapshotRefsViaPlaywright({
          cdpUrl: "http://127.0.0.1:9222",
          targetId: "tab-1",
          page: page as never,
          nodes: [{ ref: "ax1", role: "button", name: "raw", depth: 0 }],
        });
        await vi.waitFor(() => expect(markBackendDomRefsOnPage).toHaveBeenCalledOnce());

        const pending =
          kind === "ai"
            ? mod.snapshotAiViaPlaywright({
                cdpUrl: "http://127.0.0.1:9222",
                targetId: "tab-1",
                timeoutMs: 500,
              })
            : mod.snapshotRoleViaPlaywright({
                cdpUrl: "http://127.0.0.1:9222",
                targetId: "tab-1",
                refsMode: "aria",
                timeoutMs: 500,
              });
        void pending.catch(() => {});
        await vi.waitFor(() => expect(page.ariaSnapshot).toHaveBeenCalledOnce());

        await vi.advanceTimersByTimeAsync(500);

        await expect(pending).rejects.toThrow(
          new RegExp(`${kind === "ai" ? "AI" : "Role"} snapshot.*timed out after 500ms`),
        );
        releaseMarker();
        await blocker;
        await Promise.resolve();
        expect(storeRoleRefsForTarget).toHaveBeenCalledTimes(1);
        expect(storeRoleRefsForTarget).toHaveBeenLastCalledWith(
          expect.objectContaining({ refs: { ax1: { role: "button", name: "raw" } } }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["ai", "role"] as const)(
    "rejects queued %s refs after their document navigates",
    async (kind) => {
      const mainFrame = { id: "main-frame" };
      const handlers = new Map<string, (frame: unknown) => void>();
      const page = {
        ariaSnapshot: vi.fn(async () => '- button "Queued" [ref=e2]'),
        mainFrame: () => mainFrame,
        on: vi.fn((event: string, handler: (frame: unknown) => void) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      };
      let releaseMarker!: () => void;
      const markerGate = new Promise<void>((resolve) => {
        releaseMarker = resolve;
      });
      getPageForTargetId.mockResolvedValue(page);
      markBackendDomRefsOnPage.mockImplementationOnce(async () => {
        await markerGate;
        return new Set();
      });

      const mod = await import("./pw-tools-core.snapshot.js");
      const blocker = mod.storeAriaSnapshotRefsViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        page: page as never,
        nodes: [{ ref: "ax1", role: "button", name: "raw", depth: 0 }],
      });
      await vi.waitFor(() => expect(markBackendDomRefsOnPage).toHaveBeenCalledOnce());

      const pending =
        kind === "ai"
          ? mod.snapshotAiViaPlaywright({
              cdpUrl: "http://127.0.0.1:9222",
              targetId: "tab-1",
            })
          : mod.snapshotRoleViaPlaywright({
              cdpUrl: "http://127.0.0.1:9222",
              targetId: "tab-1",
              refsMode: "aria",
            });
      await vi.waitFor(() => expect(page.ariaSnapshot).toHaveBeenCalledOnce());
      handlers.get("framenavigated")?.(mainFrame);
      releaseMarker();
      await blocker;

      await expect(pending).rejects.toThrow(
        "Frame changed while its browser snapshot was being captured",
      );
      expect(storeRoleRefsForTarget).toHaveBeenCalledTimes(1);
      expect(storeRoleRefsForTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({ refs: { ax1: { role: "button", name: "raw" } } }),
      );
    },
  );

  it("rejects raw refs when navigation occurs during marker publication", async () => {
    const mainFrame = { id: "main-frame" };
    const handlers = new Map<string, (frame: unknown) => void>();
    const page = {
      on: vi.fn((event: string, handler: (frame: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    let releaseMarker!: () => void;
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: [{ snapshot: "raw" }] });
    formatAriaSnapshot.mockReturnValue([{ ref: "ax1", role: "button", name: "raw" }]);
    markBackendDomRefsOnPage.mockImplementationOnce(async () => {
      await markerGate;
      return new Set();
    });

    const mod = await import("./pw-tools-core.snapshot.js");
    const pending = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
    await vi.waitFor(() => expect(markBackendDomRefsOnPage).toHaveBeenCalledOnce());
    handlers.get("framenavigated")?.(mainFrame);
    releaseMarker();

    await expect(pending).rejects.toThrow(
      "Frame changed while its browser snapshot was being captured",
    );
    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it("does not wedge a retry when an aborted marker write never returns", async () => {
    const page = makeSnapshotPage();
    const controller = new AbortController();
    let collectCount = 0;
    withPageScopedCdpClient.mockImplementation(async () => ({
      nodes: [{ snapshot: ++collectCount === 1 ? "old" : "new" }],
    }));
    formatAriaSnapshot.mockImplementation((nodes: Array<{ snapshot?: string }>) => [
      {
        ref: nodes[0]?.snapshot === "old" ? "ax-old" : "ax-new",
        role: "button",
        name: nodes[0]?.snapshot ?? "",
      },
    ]);
    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage
      .mockImplementationOnce(
        async (opts: { signal?: AbortSignal }) =>
          await new Promise<Set<string>>((_resolve, reject) => {
            const rejectOnAbort = () =>
              reject(
                opts.signal?.reason instanceof Error
                  ? opts.signal.reason
                  : new Error(String(opts.signal?.reason ?? "aborted")),
              );
            if (opts.signal?.aborted) {
              rejectOnAbort();
              return;
            }
            opts.signal?.addEventListener("abort", rejectOnAbort, { once: true });
          }),
      )
      .mockResolvedValueOnce(new Set(["ax-new"]));

    const mod = await import("./pw-tools-core.snapshot.js");
    const first = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
    });
    void first.catch(() => {});
    await vi.waitFor(() => expect(markBackendDomRefsOnPage).toHaveBeenCalledTimes(1));
    controller.abort(new Error("first marker publication timed out"));
    await expect(first).rejects.toThrow("first marker publication timed out");

    const retry = mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
    await expect(retry).resolves.toEqual({
      nodes: [{ ref: "ax-new", role: "button", name: "new" }],
    });
    expect(markBackendDomRefsOnPage).toHaveBeenCalledTimes(2);
    expect(storeRoleRefsForTarget).toHaveBeenCalledTimes(1);
    expect(storeRoleRefsForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: { "ax-new": { role: "button", name: "new", domMarker: true } },
      }),
    );
  });

  it("invalidates old refs before a partially written marker publication aborts", async () => {
    const page = makeSnapshotPage();
    const controller = new AbortController();
    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage.mockImplementationOnce(async () => {
      controller.abort(new Error("marker publication interrupted"));
      throw controller.signal.reason;
    });

    const mod = await import("./pw-tools-core.snapshot.js");
    await expect(
      mod.storeAriaSnapshotRefsViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        page: page as never,
        signal: controller.signal,
        nodes: [{ ref: "ax1", role: "button", name: "new", backendDOMNodeId: 42, depth: 0 }],
      }),
    ).rejects.toThrow("marker publication interrupted");

    expect(invalidateRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it("passes ref-publication cancellation into a pending page lookup", async () => {
    const controller = new AbortController();
    const cancellation = new Error("ref publication lookup cancelled");
    getPageForTargetId.mockImplementationOnce(
      async (options: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () =>
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error(String(options.signal?.reason ?? "aborted")),
            );
          if (options.signal?.aborted) {
            rejectOnAbort();
            return;
          }
          options.signal?.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    );

    const mod = await import("./pw-tools-core.snapshot.js");
    const pending = mod.storeAriaSnapshotRefsViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
      nodes: [],
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(getPageForTargetId).toHaveBeenCalledOnce());

    expect(getPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      signal: controller.signal,
    });
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(markBackendDomRefsOnPage).not.toHaveBeenCalled();
    expect(storeRoleRefsForTarget).not.toHaveBeenCalled();
  });
});
