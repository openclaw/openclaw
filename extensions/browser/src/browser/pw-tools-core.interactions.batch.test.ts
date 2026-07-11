// Browser tests cover pw tools core.interactions.batch plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserActRequest } from "./client-actions.types.js";

let page: {
  evaluate: ReturnType<typeof vi.fn>;
  setViewportSize: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
} | null = null;

const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const finalizePendingBrowserInteractionAction = vi.fn<
  typeof import("./pw-session.js").finalizePendingBrowserInteractionAction
>((error) => ({
  error: error instanceof Error ? error : new Error("pending interaction failed"),
  deferred: false,
}));
const isBrowserObservedDialogBlockedError = vi.fn(() => false);
const markObservedDialogsHandledRemotelyForPage = vi.fn(() => ({}));
const isPolicyDenyNavigationError = vi.fn<
  typeof import("./pw-session.js").isPolicyDenyNavigationError
>(() => false);
const quarantineBlockedNavigationTargetForError = vi.fn(async () => {});
const refLocator = vi.fn(() => {
  throw new Error("test: refLocator should not be called");
});
const restoreRoleRefsForTarget = vi.fn(() => {});
const trackPendingBrowserInteractionAction = vi.fn(
  (err: unknown, actionPromise: Promise<unknown>, onActionResolved?: () => void) => {
    void actionPromise.then(onActionResolved, () => {});
    return err instanceof Error ? err : new Error("aborted");
  },
);
const replacePendingBrowserInteractionActionError = vi.fn(
  (_current: unknown, replacement: unknown) =>
    replacement instanceof Error ? replacement : new Error("replacement error"),
);
const wasBrowserNavigationRequestBlockedBeforeDispatch = vi.fn(() => false);
const withPageNavigationRequestGuard = vi.fn(
  async <T>({ action }: { action: () => Promise<T> }): Promise<T> => await action(),
);
const downloadDrain = vi.fn(async () => undefined);
const downloadDispose = vi.fn(() => {});
const beginActionDownloadCaptureOnPage = vi.fn(() => ({
  drain: downloadDrain,
  dispose: downloadDispose,
}));
const dialogCleanup = vi.fn(() => {});
const createObservedDialogAbortSignalForPage = vi.fn((opts?: { parentSignal?: AbortSignal }) => ({
  signal: opts?.parentSignal ?? new AbortController().signal,
  cleanup: dialogCleanup,
}));

const closePageViaPlaywright = vi.fn(async () => {});

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely,
  beginActionDownloadCaptureOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  finalizePendingBrowserInteractionAction,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  markObservedDialogsHandledRemotelyForPage,
  quarantineBlockedNavigationTargetForError,
  refLocator,
  replacePendingBrowserInteractionActionError,
  restoreRoleRefsForTarget,
  trackPendingBrowserInteractionAction,
  wasBrowserNavigationRequestBlockedBeforeDispatch,
  withPageNavigationRequestGuard,
}));

vi.mock("./pw-tools-core.snapshot.js", () => ({
  closePageViaPlaywright,
}));

const { batchViaPlaywright, executeActViaPlaywright } =
  await import("./pw-tools-core.interactions.js");

function firstEvaluateCall(): [unknown, { fnSource?: string; timeoutMs?: number }] {
  if (!page) {
    throw new Error("expected test page");
  }
  const [call] = page.evaluate.mock.calls;
  if (!call) {
    throw new Error("expected page.evaluate call");
  }
  return call as [unknown, { fnSource?: string; timeoutMs?: number }];
}

describe("batchViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isBrowserObservedDialogBlockedError.mockReturnValue(false);
    isPolicyDenyNavigationError.mockReturnValue(false);
    page = {
      evaluate: vi.fn(async () => "ok"),
      setViewportSize: vi.fn(async () => {}),
      url: vi.fn(() => "about:blank"),
    };
  });

  it("propagates evaluate timeouts through batched execution", async () => {
    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      evaluateEnabled: true,
      actions: [{ kind: "evaluate", fn: "() => 1", timeoutMs: 5000 }],
    });

    expect(result).toEqual({ results: [{ ok: true }] });
    const [evaluateFn, evaluateOptions] = firstEvaluateCall();
    expect(typeof evaluateFn).toBe("function");
    expect(evaluateOptions?.fnSource).toBe("() => 1");
    expect(evaluateOptions?.timeoutMs).toBe(4500);
  });

  it("supports resize and close inside a batch", async () => {
    const result = await batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      actions: [{ kind: "resize", width: 800, height: 600 }, { kind: "close" }],
    });

    expect(result).toEqual({ results: [{ ok: true }, { ok: true }] });
    expect(page?.setViewportSize).toHaveBeenCalledWith({ width: 800, height: 600 });
    expect(closePageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
  });

  it("never continues after a navigation policy denial", async () => {
    const blocked = Object.assign(new Error("private destination blocked"), {
      name: "SsrFBlockedError",
    });
    page?.evaluate.mockRejectedValueOnce(blocked);
    isPolicyDenyNavigationError.mockImplementation((error: unknown) => error === blocked);

    await expect(
      batchViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        evaluateEnabled: true,
        stopOnError: false,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        actions: [{ kind: "evaluate", fn: "() => 1" }, { kind: "close" }],
      }),
    ).rejects.toBe(blocked);

    expect(closePageViaPlaywright).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "direct action",
      action: { kind: "resize", width: 801, height: 601 } satisfies BrowserActRequest,
    },
    {
      label: "nested batch action",
      action: {
        kind: "batch",
        actions: [
          {
            kind: "batch",
            actions: [{ kind: "resize", width: 802, height: 602 }],
          },
        ],
      } satisfies BrowserActRequest,
    },
  ])("forwards explicit browser proxy policy through a $label", async ({ action }) => {
    vi.useFakeTimers();
    try {
      const strictPolicy = { dangerouslyAllowPrivateNetwork: false };
      const task = executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        action,
        ssrfPolicy: strictPolicy,
        browserProxyMode: "explicit-browser-proxy",
      });

      await vi.runAllTimersAsync();
      await task;

      expect(withPageNavigationRequestGuard).toHaveBeenCalledTimes(1);
      expect(withPageNavigationRequestGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          page,
          ssrfPolicy: strictPolicy,
          browserProxyMode: "explicit-browser-proxy",
          action: expect.any(Function),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
