import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserActRequest } from "./client-actions.types.js";
import {
  BrowserObservedDialogBlockedError,
  isBrowserObservedDialogBlockedError,
} from "./pw-session-contracts.js";
import { isPolicyDenyNavigationError } from "./pw-session-navigation.js";

function createPage() {
  let currentUrl = "https://example.com";
  let closed = false;
  const frames = new Set<(frame: unknown) => void>();
  const mainFrame = { url: () => currentUrl };
  return {
    page: {
      evaluate: vi.fn(async () => {}),
      isClosed: vi.fn(() => closed),
      keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async () => {}) },
      mainFrame: vi.fn(() => mainFrame),
      mouse: { click: vi.fn(async () => {}) },
      on: vi.fn((event: string, handler: (frame: unknown) => void) => {
        if (event === "framenavigated") {
          frames.add(handler);
        }
      }),
      off: vi.fn((event: string, handler: (frame: unknown) => void) => {
        if (event === "framenavigated") {
          frames.delete(handler);
        }
      }),
      url: vi.fn(() => currentUrl),
    },
    setPageUrl: (url: string) => {
      currentUrl = url;
      for (const handler of frames) {
        handler(mainFrame);
      }
    },
    setPageClosed: (value: boolean) => {
      closed = value;
    },
  };
}
let { page, setPageUrl, setPageClosed } = createPage();
const locator = {
  click: vi.fn(async () => {}),
  dragTo: vi.fn(async () => {}),
  fill: vi.fn(async () => {}),
  hover: vi.fn(async () => {}),
  press: vi.fn(async () => {}),
  scrollIntoViewIfNeeded: vi.fn(async () => {}),
  selectOption: vi.fn(async () => {}),
  setChecked: vi.fn(async () => {}),
};

const getPageForTargetId = vi.fn(async () => page);
const ensurePageState = vi.fn(() => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const quarantineBlockedNavigationTarget = vi.fn(async () => {});
const markObservedDialogsHandledRemotelyForPage = vi.fn(() => ({}));
const refLocator = vi.fn(() => locator);
const restoreRoleRefsForTarget = vi.fn(() => {});
const wasBrowserNavigationSourcePreservedAfterPolicyDenial = vi.fn(() => false);
const withPageNavigationRequestGuard = vi.fn(
  async ({
    action,
    page: actionPage,
  }: {
    action: (url: string) => Promise<unknown>;
    page: { url: () => string };
  }) => await action(actionPage.url()),
);

const closePageViaPlaywright = vi.fn(async () => {});
const resizeViewportViaPlaywright = vi.fn(async () => {});
const drainDownloads = vi.fn(async () => undefined);
const disposeDownloads = vi.fn();
const cleanupDialogAbort = vi.fn();

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely,
  beginActionDownloadCaptureOnPage: vi.fn(() => ({
    drain: drainDownloads,
    dispose: disposeDownloads,
  })),
  createObservedDialogAbortSignalForPage: vi.fn(
    ({ parentSignal }: { parentSignal?: AbortSignal }) => ({
      signal: parentSignal ?? new AbortController().signal,
      cleanup: cleanupDialogAbort,
    }),
  ),
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  markObservedDialogsHandledRemotelyForPage,
  quarantineBlockedNavigationTarget,
  refLocator,
  restoreRoleRefsForTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
}));

vi.mock("./pw-tools-core.snapshot.js", () => ({
  closePageViaPlaywright,
  resizeViewportViaPlaywright,
}));

vi.mock("./pw-session-connection.js", () => ({
  pageTargetInfo: vi.fn(async () => ({ targetId: "tab-1" })),
}));

const { executeActViaPlaywright } = await import("./pw-tools-core.interactions.execution.js");

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };

function batch({
  actions,
  stopOnError,
  ...options
}: Omit<Parameters<typeof executeActViaPlaywright>[0], "cdpUrl" | "action"> &
  Omit<Extract<BrowserActRequest, { kind: "batch" }>, "kind">) {
  return executeActViaPlaywright({
    ...target,
    ...options,
    action: { kind: "batch", actions, stopOnError },
  });
}

describe("executeActViaPlaywright batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ({ page, setPageUrl, setPageClosed } = createPage());
    for (const mock of Object.values(locator)) {
      mock.mockReset();
    }
    closePageViaPlaywright.mockImplementation(async () => setPageClosed(true));
  });

  afterEach(() => {
    expect(drainDownloads).toHaveBeenCalledOnce();
    expect(disposeDownloads).toHaveBeenCalledOnce();
    expect(cleanupDialogAbort).toHaveBeenCalledOnce();
  });

  it("does not expose pasted text when native insertion fails", async () => {
    const text = "synthetic-password-paste";
    page.keyboard.insertText.mockRejectedValueOnce(new Error(`Insert "${text}" failed`));
    const result = await batch({
      actions: [{ kind: "insertText", text }],
    });
    expect(result.results).toEqual([
      {
        ok: false,
        error: "Unable to paste text into the browser. Focus an editable field and try again.",
      },
    ]);
    expect(page.keyboard.insertText).toHaveBeenCalledWith(text);
    expect(JSON.stringify(result)).not.toContain(text);
  });

  it("aborts remaining actions after a same-URL reload", async () => {
    locator.click.mockImplementationOnce(async () => {
      setPageUrl("https://example.com");
    });

    const result = await batch({
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
      ],
    });

    expect(result).toEqual({
      targetId: "tab-1",
      results: [{ ok: true, navigated: true, url: "https://example.com" }],
      aborted: {
        reason: "navigation",
        afterAction: 1,
        url: "https://example.com",
        skipped: 1,
      },
    });
    expect(locator.hover).not.toHaveBeenCalled();
    expect(page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
  });

  it("aborts when a navigation commits after an action settles but before the next dispatch", async () => {
    let closedChecks = 0;
    page.isClosed.mockImplementation(() => {
      closedChecks += 1;
      if (closedChecks === 2) {
        setPageUrl("https://example.com/late");
      }
      return false;
    });

    const result = await batch({
      actions: [
        { kind: "click", ref: "1" },
        { kind: "hover", ref: "2" },
      ],
    });

    expect(result).toEqual({
      targetId: "tab-1",
      results: [{ ok: true, navigated: true, url: "https://example.com/late" }],
      aborted: {
        reason: "navigation",
        afterAction: 1,
        url: "https://example.com/late",
        skipped: 1,
      },
    });
    expect(locator.hover).not.toHaveBeenCalled();
  });

  it("supports resize and close inside a batch", async () => {
    const result = await batch({
      actions: [{ kind: "resize", width: 800, height: 600 }, { kind: "close" }],
    });

    expect(result).toEqual({ targetId: "tab-1", results: [{ ok: true }, { ok: true }] });
    expect(resizeViewportViaPlaywright).toHaveBeenCalledWith({
      ...target,
      width: 800,
      height: 600,
      signal: expect.any(AbortSignal),
    });
    expect(closePageViaPlaywright).toHaveBeenCalledWith(target);
  });

  it.each([
    { name: "scrollIntoView", action: { kind: "scrollIntoView", ref: "1" } as const },
    { name: "drag", action: { kind: "drag", startRef: "1", endRef: "2" } as const },
    { name: "clickCoords", action: { kind: "clickCoords", x: 10, y: 20 } as const },
    { name: "insertText", action: { kind: "insertText", text: "  pasted 🦞\n" } as const },
    {
      name: "select",
      action: { kind: "select" as const, ref: "1", values: ["one"] },
    },
    {
      name: "fill",
      action: {
        kind: "fill" as const,
        fields: [{ ref: "1", type: "text", value: "value" }],
      },
    },
    { name: "evaluate", action: { kind: "evaluate", fn: "() => true" } as const },
  ])("guards batched $name document requests with the proxy policy", async ({ action }) => {
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

    const result = await batch({
      actions: [action],
      evaluateEnabled: true,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });

    expect(result).toEqual({ targetId: "tab-1", results: [{ ok: true }] });
    expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });
    expect(assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith({
      ...target,
      page,
      response: null,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
      targetId: "tab-1",
    });
  });

  it("preserves proxy policy through nested batches", async () => {
    const ssrfPolicy = { dangerouslyAllowPrivateNetwork: false } as const;

    const result = await batch({
      actions: [
        {
          kind: "batch",
          actions: [{ kind: "click", ref: "1" }],
        },
      ],
      evaluateEnabled: true,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });

    expect(result).toEqual({ targetId: "tab-1", results: [{ ok: true }] });
    expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
      action: expect.any(Function),
      onPolicyCheckStarted: expect.any(Function),
      onPolicyDenied: expect.any(Function),
      page,
      ssrfPolicy,
      browserProxyMode: "explicit-browser-proxy",
    });
  });

  it.each([
    { innerStopOnError: false, outerStopOnError: undefined },
    { innerStopOnError: undefined, outerStopOnError: false },
  ])(
    "reports nested failure with inner stop=$innerStopOnError and outer stop=$outerStopOnError",
    async ({ innerStopOnError, outerStopOnError }) => {
      locator.fill.mockRejectedValueOnce(new Error("not editable"));

      const result = await batch({
        targetId: "tab-1",
        stopOnError: outerStopOnError,
        actions: [
          {
            kind: "batch",
            stopOnError: innerStopOnError,
            actions: [
              { kind: "type", ref: "1", text: "value" },
              { kind: "hover", ref: "2" },
            ],
          },
          { kind: "press", key: "Enter" },
        ],
      });

      expect(result.results).toEqual([
        { ok: false, error: "not editable" },
        ...(outerStopOnError === false ? [{ ok: true }] : []),
      ]);
      expect(locator.hover).toHaveBeenCalledTimes(innerStopOnError === false ? 1 : 0);
      expect(page.keyboard.press).toHaveBeenCalledTimes(outerStopOnError === false ? 1 : 0);
    },
  );

  it("reports the first nested failure after all continue-on-error actions run", async () => {
    locator.fill.mockRejectedValueOnce(new Error("first failure"));
    locator.hover.mockRejectedValueOnce(new Error("second failure"));

    const result = await batch({
      actions: [
        {
          kind: "batch",
          stopOnError: false,
          actions: [
            { kind: "type", ref: "1", text: "value" },
            { kind: "hover", ref: "2" },
            { kind: "press", key: "Enter" },
          ],
        },
      ],
    });

    expect(result).toEqual({
      targetId: "tab-1",
      results: [{ ok: false, error: "first failure" }],
    });
    expect(locator.hover).toHaveBeenCalledOnce();
    expect(page.keyboard.press).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: "navigation", nested: false, stopOnError: false },
    { reason: "closed", nested: true, stopOnError: undefined },
  ])(
    "preserves failure and $reason abort details (nested=$nested, stop=$stopOnError)",
    async ({ reason, nested, stopOnError }) => {
      locator.fill.mockRejectedValueOnce(new Error("action failed"));
      locator.click.mockImplementationOnce(async () => {
        if (reason === "navigation") {
          setPageUrl("https://example.com/next");
        } else {
          setPageClosed(true);
        }
        if (!nested) {
          throw new Error("action failed");
        }
      });

      const result = await batch({
        stopOnError,
        actions: [
          nested
            ? {
                kind: "batch",
                stopOnError: false,
                actions: [
                  { kind: "type", ref: "1", text: "value" },
                  { kind: "click", ref: "2" },
                  { kind: "hover", ref: "3" },
                ],
              }
            : { kind: "click", ref: "1" },
          { kind: "press", key: "Enter" },
        ],
      });
      const url = reason === "navigation" ? "https://example.com/next" : "https://example.com";

      expect(result).toEqual({
        targetId: "tab-1",
        results: [
          {
            ok: false,
            error: "action failed",
            ...(reason === "navigation" ? { navigated: true, url } : {}),
          },
        ],
        aborted: { reason, afterAction: 1, url, skipped: 1 },
      });
      expect(locator.hover).not.toHaveBeenCalled();
      expect(page.keyboard.press).not.toHaveBeenCalled();
    },
  );

  it.each([
    new SsrFBlockedError("browser navigation blocked by policy"),
    new BrowserObservedDialogBlockedError({ dialogs: { pending: [], recent: [] } }),
  ])("stops permissive nested batches on $name", async (error) => {
    locator.fill.mockRejectedValueOnce(error);

    const result = batch({
      stopOnError: false,
      actions: [
        {
          kind: "batch",
          stopOnError: false,
          actions: [
            { kind: "type", ref: "1", text: "value" },
            { kind: "hover", ref: "2" },
          ],
        },
        { kind: "press", key: "Enter" },
      ],
    });
    if (error instanceof BrowserObservedDialogBlockedError) {
      await expect(result).resolves.toEqual({
        targetId: "tab-1",
        blockedByDialog: true,
        browserState: error.browserState,
      });
    } else {
      await expect(result).rejects.toBe(error);
    }
    expect(locator.hover).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });
});
