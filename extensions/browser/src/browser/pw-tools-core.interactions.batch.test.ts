import { EventEmitter } from "node:events";
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
  const events = new EventEmitter();
  const mainFrame = { url: () => currentUrl };
  return {
    page: {
      evaluate: vi.fn(async () => {}),
      isClosed: vi.fn(() => closed),
      keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async () => {}) },
      mainFrame: vi.fn(() => mainFrame),
      mouse: { click: vi.fn(async () => {}) },
      on: vi.fn(events.on.bind(events)),
      off: vi.fn(events.off.bind(events)),
      url: vi.fn(() => currentUrl),
    },
    setPageUrl: (url: string) => {
      currentUrl = url;
      events.emit("framenavigated", mainFrame);
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

const session = await vi.hoisted(async () => {
  const { createGuardSession } = await import("./pw-tools-core.guard-test-support.js");
  return createGuardSession(
    () => page,
    () => locator,
  );
});
const { assertPageNavigationCompletedSafely, withPageNavigationRequestGuard } = session;

const closePageViaPlaywright = vi.fn(async () => {});
const resizeViewportViaPlaywright = vi.fn(async () => {});
const drainDownloads = vi.fn(async () => undefined);
const disposeDownloads = vi.fn();
const cleanupDialogAbort = vi.fn();

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

vi.mock("./pw-tools-core.snapshot.js", () => ({
  closePageViaPlaywright,
  resizeViewportViaPlaywright,
}));

vi.mock("./pw-session-connection.js", () => ({
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
function expectProxyGuard() {
  expect(withPageNavigationRequestGuard).toHaveBeenCalledWith({
    action: expect.any(Function),
    onPolicyCheckStarted: expect.any(Function),
    onPolicyDenied: expect.any(Function),
    page,
    signal: expect.any(AbortSignal),
    ...proxyPolicy,
  });
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
      expectProxyGuard();
      expect(assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith({
        ...target,
        page,
        response: null,
        signal: expect.any(AbortSignal),
        ...proxyPolicy,
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
