import { EventEmitter } from "node:events";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import type { BrowserActRequest } from "./client-actions.types.js";
import { BrowserTabCrashedError } from "./errors.js";
import { closePlaywrightBrowserConnection as closeRealBrowserConnection } from "./pw-session-actions.js";
import { getPageForTargetId as getRealPageForTargetId } from "./pw-session-connection.js";
import {
  BrowserObservedDialogBlockedError,
  isBrowserObservedDialogBlockedError,
} from "./pw-session-contracts.js";
import { isPolicyDenyNavigationError } from "./pw-session-navigation.js";

function createPage() {
  let currentUrl = "https://example.com";
  let closed = false;
  const events = new EventEmitter();
  const mainFrame = { url: () => currentUrl };
  const context = {
    pages: () => [page],
    browser: () => browser,
    on: vi.fn(),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId: "tab-1" } } : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  };
  const browser = {
    contexts: () => [context],
    newBrowserCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => ({ commandLine: "" })),
      detach: vi.fn(async () => {}),
    })),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const page = {
    evaluate: vi.fn(async () => {}),
    context: vi.fn(() => context),
    close: vi.fn(async () => {
      closed = true;
      events.emit("close");
    }),
    isClosed: vi.fn(() => closed),
    keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async () => {}) },
    mainFrame: vi.fn(() => mainFrame),
    mouse: { click: vi.fn(async () => {}) },
    on: vi.fn(events.on.bind(events)),
    off: vi.fn(events.off.bind(events)),
    url: vi.fn(() => currentUrl),
  };
  return {
    page,
    browser,
    emitPageEvent: (event: string) => events.emit(event),
    setPageUrl: (url: string) => {
      currentUrl = url;
      events.emit("framenavigated", mainFrame);
    },
    setPageClosed: (value: boolean) => {
      closed = value;
    },
  };
}
let { page, browser, emitPageEvent, setPageUrl, setPageClosed } = createPage();
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

const session = await vi.hoisted(async () => {
  const { createGuardSession } = await import("./pw-tools-core.guard-test-support.js");
  return createGuardSession(
    () => page,
    () => locator,
  );
});
const { assertPageNavigationCompletedSafely, withPageNavigationRequestGuard } = session;

const closePageViaPlaywright = vi.fn<
  typeof import("./pw-tools-core.snapshot.js").closePageViaPlaywright
>(async () => {});
const resizeViewportViaPlaywright = vi.fn(async () => {});
const drainDownloads = vi.fn(async () => undefined);
const disposeDownloads = vi.fn();
const cleanupDialogAbort = vi.fn();
const registerManagedProxyBrowserCdpBypassMock = vi.hoisted(() =>
  vi.fn<(url: string) => (() => void) | undefined>(() => undefined),
);
const actualClosePageViaPlaywright = vi.hoisted(() => ({
  current:
    undefined as unknown as typeof import("./pw-tools-core.snapshot.js").closePageViaPlaywright,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));
vi.mock(
  "./pw-session-cdp-transport.js",
  () => import("./pw-session-cdp-transport.test-support.js"),
);

// mock-isolation: Exercise synthetic page actions without connecting to a live browser session.
vi.mock("./pw-session.js", () => ({
  ...session,
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
  ensurePageState: vi.fn(() => {}),
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
}));

vi.mock("./pw-tools-core.snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pw-tools-core.snapshot.js")>();
  actualClosePageViaPlaywright.current = actual.closePageViaPlaywright;
  return {
    ...actual,
    closePageViaPlaywright,
    resizeViewportViaPlaywright,
  };
});

vi.mock("./pw-session-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session-connection.js")>()),
  pageTargetInfo: vi.fn(async () => ({ targetId: "tab-1" })),
}));

const { executeActViaPlaywright } = await import("./pw-tools-core.interactions.execution.js");

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };
const click = { kind: "click", ref: "1" } as const;
const hover = { kind: "hover", ref: "2" } as const;
const type = { kind: "type", ref: "1", text: "value" } as const;
const press = { kind: "press", key: "Enter" } as const;
const proxyPolicy = {
  ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
  browserProxyMode: "explicit-browser-proxy",
} as const;
function nested(actions: BrowserActRequest[]): BrowserActRequest {
  return { kind: "batch", actions, stopOnError: false };
}
function batch(
  actions: BrowserActRequest[],
  {
    stopOnError,
    ...options
  }: Omit<Parameters<typeof executeActViaPlaywright>[0], "cdpUrl" | "action"> & {
    stopOnError?: boolean;
  } = {},
) {
  return executeActViaPlaywright({
    ...target,
    ...options,
    action: { kind: "batch", actions, stopOnError },
  });
}

async function useRealCrashedResolver() {
  const resolvePage = session.getPageForTargetId;
  const previousResolve = resolvePage.getMockImplementation();
  if (!previousResolve) {
    throw new Error("the crashed-target fixture needs the default page resolver");
  }
  type PageResolver = NonNullable<typeof previousResolve>;
  const connectSpy = vi
    .spyOn(chromium, "connectOverCDP")
    .mockResolvedValue(browser as unknown as import("playwright-core").Browser);
  const endpointSpy = vi.spyOn(chromeModule, "getChromeWebSocketEndpoint").mockResolvedValue(null);
  resolvePage.mockImplementation(getRealPageForTargetId as unknown as PageResolver);
  await getRealPageForTargetId({ ...target, allowCrashed: true });
  emitPageEvent("crash");
  return async () => {
    resolvePage.mockImplementation(previousResolve);
    connectSpy.mockRestore();
    endpointSpy.mockRestore();
    await closeRealBrowserConnection();
  };
}

describe("executeActViaPlaywright batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ({ page, browser, emitPageEvent, setPageUrl, setPageClosed } = createPage());
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
    const result = await batch([{ kind: "insertText", text }]);
    expect(result.results).toEqual([
      {
        ok: false,
        error: "Unable to paste text into the browser. Focus an editable field and try again.",
      },
    ]);
    expect(page.keyboard.insertText).toHaveBeenCalledWith(text);
    expect(JSON.stringify(result)).not.toContain(text);
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

    const result = await batch([click, hover]);

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
    const result = await batch([{ kind: "resize", width: 800, height: 600 }, { kind: "close" }]);

    expect(result).toEqual({ targetId: "tab-1", results: [{ ok: true }, { ok: true }] });
    expect(resizeViewportViaPlaywright).toHaveBeenCalledWith({
      ...target,
      width: 800,
      height: 600,
      signal: expect.any(AbortSignal),
    });
    expect(closePageViaPlaywright).toHaveBeenCalledWith(target);
  });

  it("resolves a crashed target so a close-only batch can clean it up", async () => {
    const restoreResolver = await useRealCrashedResolver();
    closePageViaPlaywright.mockImplementation(actualClosePageViaPlaywright.current);
    try {
      const result = await batch([{ kind: "close" }]);
      expect(result).toEqual({ targetId: "tab-1", results: [{ ok: true }] });
      expect(closePageViaPlaywright).toHaveBeenCalledWith(target);
      expect(page.close).toHaveBeenCalledOnce();
      expect(page.isClosed()).toBe(true);
      expect(
        session.getPageForTargetId.mock.calls.map(([options]) => options.allowCrashed),
      ).toEqual([true, true]);
    } finally {
      await restoreResolver();
    }
  });

  it("refuses non-close children on a crashed target", async () => {
    const restoreResolver = await useRealCrashedResolver();
    try {
      await expect(batch([click])).rejects.toThrow(BrowserTabCrashedError);
      expect(locator.click).not.toHaveBeenCalled();
      expect(
        session.getPageForTargetId.mock.calls.map(([options]) => options.allowCrashed),
      ).toEqual([true, undefined]);
    } finally {
      await restoreResolver();
    }
  });

  it.each([
    { kind: "scrollIntoView", ref: "1" },
    { kind: "drag", startRef: "1", endRef: "2" },
    { kind: "clickCoords", x: 10, y: 20 },
    { kind: "insertText", text: "  pasted 🦞\n" },
    { kind: "select", ref: "1", values: ["one"] },
    { kind: "fill", fields: [{ ref: "1", type: "text", value: "value" }] },
    { kind: "evaluate", fn: "() => true" },
    { kind: "batch", actions: [click] },
  ] satisfies BrowserActRequest[])(
    "guards batched $kind document requests with the proxy policy",
    async (action) => {
      const result = await batch([action], {
        evaluateEnabled: true,
        ...proxyPolicy,
      });

      expect(result).toEqual({ targetId: "tab-1", results: [{ ok: true }] });
      const guard = { page, signal: expect.any(AbortSignal), ...proxyPolicy };
      expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
        ...guard,
        action: expect.any(Function),
        onPolicyCheckStarted: expect.any(Function),
        onPolicyDenied: expect.any(Function),
      });
      expect(assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith({
        ...target,
        ...guard,
        response: null,
      });
    },
  );

  it.each([false, true])("reports the first nested failure (multiple=%s)", async (multiple) => {
    const error = multiple ? "first failure" : "not editable";
    locator.fill.mockRejectedValueOnce(new Error(error));
    if (multiple) {
      locator.hover.mockRejectedValueOnce(new Error("second failure"));
    }
    const actions = nested([type, hover, ...(multiple ? [{ ...press, delayMs: 0 }] : [])]);
    const result = await batch([actions, ...(!multiple ? [press] : [])]);
    expect(result).toEqual({
      targetId: "tab-1",
      results: [{ ok: false, error }],
    });
    expect(locator.hover).toHaveBeenCalledOnce();
    if (multiple) {
      expect(page.keyboard.press).toHaveBeenCalledExactlyOnceWith("Enter", { delay: 0 });
    } else {
      expect(page.keyboard.press).not.toHaveBeenCalled();
    }
  });

  it("preserves failure and aborts after a same-URL reload", async () => {
    locator.click.mockImplementationOnce(async () => {
      setPageUrl("https://example.com");
      throw new Error("action failed");
    });
    const result = await batch([click, press], { stopOnError: false });
    expect(result).toEqual({
      targetId: "tab-1",
      results: [{ ok: false, error: "action failed", navigated: true, url: "https://example.com" }],
      aborted: { reason: "navigation", afterAction: 1, url: "https://example.com", skipped: 1 },
    });
    expect(locator.hover).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
    expect(page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
  });

  it.each([
    new SsrFBlockedError("browser navigation blocked by policy"),
    new BrowserObservedDialogBlockedError({ dialogs: { pending: [], recent: [] } }),
  ])("stops permissive nested batches on $name", async (error) => {
    locator.fill.mockRejectedValueOnce(error);

    const result = batch([nested([type, hover]), press], { stopOnError: false });
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
