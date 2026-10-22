import fs from "node:fs/promises";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type { Frame, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import { getObservedBrowserStateForPage } from "./pw-session-state.js";
import {
  armObservedDialogResponseOnPage,
  beginActionDownloadCaptureOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  isBrowserObservedDialogBlockedError,
  isDownloadStartingNavigationError,
  refLocator,
  respondToObservedDialogOnPage,
  restoreRoleRefsForTarget,
  storeRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";
import { reconcileRemoteDialogAfterActionSettled } from "./pw-tools-core.interactions.navigation.js";

type MutableDownload = {
  url: () => string;
  cancel: () => Promise<void>;
  suggestedFilename: () => string;
  saveAs: ReturnType<typeof vi.fn>;
  path?: () => Promise<string>;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakePage() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), cb]);
  });
  const off = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    handlers.set(
      event,
      (handlers.get(event) ?? []).filter((handler) => handler !== cb),
    );
  });
  const getByRole = vi.fn();
  const frameLocator = vi.fn();
  const frameGetByRole = vi.fn();
  const selectedFrame = {
    url: () => "https://frame.example.com",
    getByRole: frameGetByRole,
  } as unknown as Frame;
  const locator = vi.fn();

  const mainFrame = { url: () => "https://test.example.com" };
  const page = {
    on,
    off,
    getByRole,
    frameLocator,
    locator,
    mainFrame: () => mainFrame,
  } as unknown as Page;

  return {
    page,
    emit: (event: string, arg: unknown) => handlers.get(event)?.[0]?.(arg),
    emitAll: (event: string, arg: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(arg);
      }
    },
    mainFrame,
    selectedFrame,
    mocks: { on, frameGetByRole, getByRole, frameLocator, locator },
  };
}

function saveContents(contents: string, gate?: Promise<void>) {
  return vi.fn(async (outPath: string) => {
    if (gate) {
      await gate;
    }
    await fs.writeFile(outPath, contents, "utf8");
  });
}

function observedPage() {
  const harness = fakePage();
  return {
    ...harness,
    state: ensurePageState(harness.page),
    send: (...args: Parameters<typeof download>) => {
      const candidate = download(...args);
      harness.emit("download", candidate);
      return candidate;
    },
  };
}

function download(
  filename: string,
  saveAs = vi.fn(async (_outPath: string) => {}),
  url = `https://example.com/${filename}`,
): MutableDownload {
  return {
    url: () => url,
    cancel: vi.fn(async () => {}),
    suggestedFilename: () => filename,
    saveAs,
  };
}

function firstSavePath(saveAs: MutableDownload["saveAs"]): string {
  const savedPath = saveAs.mock.calls[0]?.[0];
  if (typeof savedPath !== "string") {
    throw new Error("Expected saved download path");
  }
  return savedPath;
}

function storedRefs(
  page: Page,
  name: string,
  opts: Partial<Parameters<typeof storeRoleRefsForTarget>[0]> = {},
) {
  storeRoleRefsForTarget({
    page,
    cdpUrl: "http://127.0.0.1:9222",
    targetId: "t1",
    refs: { e1: { role: "button", name } },
    mode: "role",
    ...opts,
  });
}

const captured = (suggestedFilename: string) => [expect.objectContaining({ suggestedFilename })];

describe("pw-session refLocator", () => {
  it("matches empty accessibility names in the captured snapshot Frame", () => {
    const { page, selectedFrame, mocks, state } = observedPage();
    state.roleRefs = { ax12: { role: "button", name: "" } };
    state.roleRefsFrame = selectedFrame;
    refLocator(page, "ax12");
    expect(mocks.frameGetByRole).toHaveBeenCalledWith("button", { name: "", exact: true });
    expect(mocks.getByRole).not.toHaveBeenCalled();
    expect(mocks.frameLocator).not.toHaveBeenCalled();
  });

  it.each([
    ["aria", { roleRefsMode: "aria" }, "aria-ref=e1"],
    [
      "backend-marked DOM",
      { roleRefs: { e1: { role: "button", name: "OK", domMarker: true } } },
      `[${BROWSER_REF_MARKER_ATTRIBUTE}="e1"]`,
    ],
  ] as const)("uses %s locators for role refs", (_mode, refs, selector) => {
    const { page, mocks, state } = observedPage();
    Object.assign(state, refs);
    refLocator(page, "e1");
    expect(mocks.locator).toHaveBeenCalledWith(selector);
  });

  it("rejects unknown ax refs instead of timing out on aria-ref locators", () => {
    const { page, mocks } = fakePage();
    expect(() => refLocator(page, "ax12")).toThrow(/Unknown ref/);
    expect(mocks.locator).not.toHaveBeenCalled();
  });
});

describe("pw-session role refs cache", () => {
  it("restores fresh post-navigation refs for a replacement Page", () => {
    const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "t1" };

    const { page: pageA, emit, mainFrame } = fakePage();
    storedRefs(pageA, "Page A", target);
    emit("framenavigated", mainFrame);
    expect(ensurePageState(pageA).roleRefs).toBeUndefined();

    storedRefs(pageA, "Page B", {
      refs: { e1: { role: "heading", name: "Page B" } },
      mode: "aria",
    });

    const { page: pageB } = fakePage();
    restoreRoleRefsForTarget({ ...target, page: pageB });
    expect(ensurePageState(pageB).roleRefs).toEqual({
      e1: { role: "heading", name: "Page B" },
    });
    expect(ensurePageState(pageB).roleRefsMode).toBe("aria");
  });

  it("invalidates page-wide aria refs on subframe navigation", () => {
    const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "aria-target-framenavigated" };
    const { page, emit } = fakePage();
    storedRefs(page, "Embedded", { ...target, mode: "aria" });

    emit("framenavigated", { url: () => "https://frame.example/new" });

    expect(ensurePageState(page).roleRefs).toBeUndefined();
    const { page: replacementPage } = fakePage();
    restoreRoleRefsForTarget({ ...target, page: replacementPage });
    expect(ensurePageState(replacementPage).roleRefs).toBeUndefined();
  });
});

describe("pw-session ensurePageState", () => {
  it("stores unmanaged downloads under unique managed paths", async () => {
    const { send } = observedPage();

    const saveAsA = saveContents("download-a");
    const saveAsB = saveContents("download-b");
    const downloadA = send("report.pdf", saveAsA, "");
    const downloadB = send("report.pdf", saveAsB, "");

    const managedPathA = await downloadA.path?.();
    const managedPathB = await downloadB.path?.();

    expect(managedPathA).not.toBe(managedPathB);
    for (const [managedPath, saveAs] of [
      [managedPathA, saveAsA],
      [managedPathB, saveAsB],
    ] as const) {
      expect(path.dirname(managedPath ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
      expect(path.basename(managedPath ?? "")).toMatch(/-report\.pdf$/);
      const savedPath = firstSavePath(saveAs);
      expect(savedPath).not.toBe(managedPath);
      expect(savedPath.length).toBeGreaterThan(0);
      const relativeStagedPath = path.relative(await fs.realpath(DEFAULT_DOWNLOAD_DIR), savedPath);
      expect(relativeStagedPath.startsWith(`..${path.sep}`)).toBe(false);
      expect(path.isAbsolute(relativeStagedPath)).toBe(false);
      await expect(fs.access(path.dirname(savedPath))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.readFile(managedPathA ?? "", "utf8")).resolves.toBe("download-a");
    await expect(fs.readFile(managedPathB ?? "", "utf8")).resolves.toBe("download-b");
  });

  it("suppresses unmanaged download save rejections until path is awaited", async () => {
    const { page, emit } = fakePage();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    ensurePageState(page);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const err = new Error("save failed");
    const failed = download("report.pdf", vi.fn().mockRejectedValue(err), "");

    try {
      emit("download", failed);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandled).toStrictEqual([]);
      await expect(failed.path?.()).rejects.toThrow("save failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("captures a just-late action download within the first-event grace", async () => {
    const { page, send } = observedPage();
    const capture = beginActionDownloadCaptureOnPage(page);
    const saveAs = saveContents("late-action-download");
    const drain = capture.drain({ firstEventGraceMs: 1_000 });

    setImmediate(() => send("late.txt", saveAs));

    await expect(drain).resolves.toEqual(captured("late.txt"));
    capture.dispose();
  });

  it("detaches ownership before waiting for slow file saves", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { page, send } = observedPage();
    const firstSaveGate = Promise.withResolvers<void>();
    const beforeSave = vi.fn(async () => {});
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const firstSave = saveContents("first", firstSaveGate.promise);
    send("first.txt", firstSave);

    const drain = capture.drain();
    await vi.advanceTimersByTimeAsync(250);
    const lateSave = saveContents("late");
    const lateDownload = send("late.txt", lateSave);
    firstSaveGate.resolve();

    await expect(drain).resolves.toEqual(captured("first.txt"));
    await expect(lateDownload.path?.()).resolves.toMatch(/-late\.txt$/);
    expect(beforeSave).toHaveBeenCalledOnce();
    expect(lateSave).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("keeps started saves with their owner and assigns future downloads to the latest action", async () => {
    const { page, send } = observedPage();
    const first = beginActionDownloadCaptureOnPage(page);
    const firstSaveAs = saveContents("first-action-download");
    send("first.txt", firstSaveAs);

    const latest = beginActionDownloadCaptureOnPage(page);
    first.dispose();
    const latestSaveAs = saveContents("latest-action-download");
    send("latest.txt", latestSaveAs);

    await expect(first.drain()).resolves.toEqual(captured("first.txt"));
    await expect(latest.drain()).resolves.toEqual(captured("latest.txt"));
    latest.dispose();
    expect(firstSaveAs).toHaveBeenCalledOnce();
    expect(latestSaveAs).toHaveBeenCalledOnce();
  });

  it("leaves action capture empty while an explicit download owner is armed", async () => {
    const { page, send, state } = observedPage();
    state.downloadWaiterDepth = 1;
    const capture = beginActionDownloadCaptureOnPage(page);
    const explicit = send("explicit.txt", undefined, "");

    await expect(capture.drain()).resolves.toBeUndefined();
    capture.dispose();
    expect(explicit).not.toHaveProperty("path");
    expect(explicit.saveAs).not.toHaveBeenCalled();
  });

  it("drains late siblings before surfacing the first download policy failure", async () => {
    const { page, send } = observedPage();
    const blocked = new Error("blocked action download");
    const beforeSave = vi.fn().mockRejectedValue(blocked);
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const firstSave = vi.fn(async () => {});
    const secondSave = vi.fn(async () => {});

    send("first.txt", firstSave, "http://127.0.0.1/first.txt");
    setImmediate(() => send("second.txt", secondSave, "http://127.0.0.1/second.txt"));

    await expect(capture.drain()).rejects.toBe(blocked);
    capture.dispose();
    expect(beforeSave).toHaveBeenCalledTimes(2);
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).not.toHaveBeenCalled();
  });

  it("surfaces a sibling policy denial without waiting for an allowed slow save", async () => {
    const { page, send } = observedPage();
    const blocked = new Error("blocked sibling download");
    const beforeSave = vi.fn(async (candidate: { url: string }) => {
      if (candidate.url.endsWith("/blocked.txt")) {
        throw blocked;
      }
    });
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const allowedSaveGate = Promise.withResolvers<void>();
    const allowedDownload = send("allowed.txt", saveContents("allowed", allowedSaveGate.promise));
    setImmediate(() => send("blocked.txt"));

    await expect(capture.drain()).rejects.toBe(blocked);
    allowedSaveGate.resolve();
    await expect(allowedDownload.path?.()).resolves.toMatch(/-allowed\.txt$/);
    capture.dispose();
  });

  it("surfaces action-owned download save failures without an unhandled rejection", async () => {
    const { page, emit } = observedPage();
    const capture = beginActionDownloadCaptureOnPage(page);
    const error = new Error("action download save failed");
    const cancel = vi.fn(async () => {
      throw new Error("browser disconnected during cancellation");
    });

    emit("download", {
      ...download("failed.txt", vi.fn().mockRejectedValue(error), ""),
      cancel,
    });

    await expect(capture.drain()).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("captures navigation downloads under managed paths", async () => {
    const { page, emitAll, state } = observedPage();
    const capture = createDownloadCaptureForPage(page, state, 1_000);
    const saveAs = saveContents("attachment");
    emitAll("download", download("export.csv", saveAs));

    const result = await capture.promise;
    expect(result.url).toBe("https://example.com/export.csv");
    expect(result.suggestedFilename).toBe("export.csv");
    expect(path.dirname(result.path)).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(result.path)).toMatch(/-export\.csv$/);
    expect(firstSavePath(saveAs)).not.toBe(result.path);
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("attachment");
  });

  it("validates captured navigation downloads before saving managed bytes", async () => {
    const { page, emitAll, state } = observedPage();
    const blocked = new Error("blocked download");
    const beforeSave = vi.fn().mockRejectedValue(blocked);
    const capture = createDownloadCaptureForPage(page, state, 1_000, { beforeSave });
    const saveAs = saveContents("blocked");
    const attachment = download("export.csv", saveAs, "http://127.0.0.1:18080/export.csv");

    emitAll("download", attachment);

    await expect(capture.promise).rejects.toBe(blocked);
    expect(beforeSave).toHaveBeenCalledWith({
      url: "http://127.0.0.1:18080/export.csv",
      suggestedFilename: "export.csv",
    });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("lets explicit download owners arm while passive capture yields", () => {
    const { page, state } = observedPage();
    state.downloadWaiterDepth = 1;

    const passive = createDownloadCaptureForPage(page, state, 1_000);
    const explicit = createDownloadCaptureForPage(page, state, 1_000, { mode: "explicit" });

    expect(passive.armed).toBe(false);
    expect(explicit.armed).toBe(true);
    expect(state.downloadWaiterDepth).toBe(2);
    explicit.cancel();
    expect(state.downloadWaiterDepth).toBe(1);
  });

  it("recognizes Playwright download-starting navigation aborts", () => {
    const target = "http://127.0.0.1:3333/download";
    const aborted = (url: string) => new Error(`page.goto: net::ERR_ABORTED at ${url}`);
    expect(isDownloadStartingNavigationError(new Error("page.goto: Download is starting"))).toBe(
      true,
    );
    expect(isDownloadStartingNavigationError(new Error("page.goto: net::ERR_ABORTED"))).toBe(false);
    expect(isDownloadStartingNavigationError(aborted(target), target)).toBe(true);
    expect(isDownloadStartingNavigationError(aborted("http://127.0.0.1:3333/other"), target)).toBe(
      false,
    );
    expect(isDownloadStartingNavigationError(new Error("Navigation failed"))).toBe(false);
  });

  it("bounds page-controlled text while tracking network requests", () => {
    const { emit, state } = observedPage();
    const oversized = `${"x".repeat(2047)}😀tail`;
    const consoleMessage = {
      type: () => oversized,
      text: () => oversized,
      location: () => ({ url: oversized, lineNumber: 1, columnNumber: 2 }),
    };
    const pageError = Object.assign(new Error(oversized), { name: oversized, stack: oversized });
    const req = {
      method: () => "GET",
      url: () => oversized,
      resourceType: () => "xhr",
      failure: () => ({ errorText: oversized }),
    };
    emit("request", req);
    emit("response", { request: () => req, status: () => 500, ok: () => false });
    emit("requestfailed", req);
    emit("console", consoleMessage);
    emit("pageerror", pageError);

    const consoleEntry = state.console.at(-1);
    const errorEntry = state.errors.at(-1);
    const request = [...state.requests.values()].at(-1);
    for (const value of [
      consoleEntry?.type,
      consoleEntry?.text,
      consoleEntry?.location?.url,
      errorEntry?.message,
      errorEntry?.name,
      errorEntry?.stack,
      request?.url,
      request?.failureText,
    ]) {
      expect(value?.length).toBeLessThanOrEqual(2048);
      expect(value).not.toContain("tail");
      expect(value?.charCodeAt((value?.length ?? 0) - 1)).not.toBe(0xd83d);
    }
    expect(request).toMatchObject({ method: "GET", resourceType: "xhr", status: 500, ok: false });
  });

  it("clears frame-scoped role refs on frame detachment", () => {
    const { page, emit, selectedFrame, state } = observedPage();

    storedRefs(page, "Inside frame", {
      frameSelector: "iframe#content",
      frame: selectedFrame,
    });

    emit("framedetached", { url: () => "https://ads.example.com" });
    expect(state.roleRefs).toBeDefined();

    emit("framedetached", selectedFrame);
    expect(state.roleRefs).toBeUndefined();
    expect(state.roleRefsFrame).toBeUndefined();
  });
});

function createPageHarness() {
  const { page, emitAll } = observedPage();
  return {
    page,
    dialogs: () => getObservedBrowserStateForPage(page).dialogs,
    emit: emitAll,
  };
}

function createDialog(
  overrides: Partial<{ type: string; message: string; defaultValue: string }> = {},
) {
  return {
    type: vi.fn(() => overrides.type ?? "confirm"),
    message: vi.fn(() => overrides.message ?? "Continue?"),
    defaultValue: vi.fn(() => overrides.defaultValue ?? ""),
    accept: vi.fn(async (_promptText?: string) => {}),
    dismiss: vi.fn(async () => {}),
  };
}

describe("observed browser dialogs", () => {
  it.each(["agent", "remote"] as const)("records a dialog responded to by %s", async (closedBy) => {
    const { page, emit, dialogs } = createPageHarness();
    const remote = closedBy === "remote";
    const message = remote ? "Continue?" : "Ship it?";
    const dialog = createDialog({ message });
    if (remote) {
      dialog.dismiss.mockRejectedValue(new Error("Protocol error: No dialog is showing"));
    }
    emit("dialog", dialog);
    expect(dialogs().pending).toMatchObject([{ id: "d1", type: "confirm", message }]);
    const closed = await respondToObservedDialogOnPage({
      page,
      dialogId: "d1",
      accept: !remote,
      promptText: remote ? undefined : "yes",
    });
    if (!remote) {
      expect(dialog.accept).toHaveBeenCalledWith("yes");
    }
    expect(closed.closedBy).toBe(closedBy);
    expect(closed).not.toHaveProperty("dialog");
    expect(dialogs()).toMatchObject({ pending: [], recent: [{ id: "d1", closedBy }] });
  });

  it("aborts every in-flight action and consumes a failed armed dialog", async () => {
    const accept = true;
    const { page, emit, dialogs } = createPageHarness();
    const dialog = createDialog();
    const failure = new Error("Browser dialog response failed");
    dialog[accept ? "accept" : "dismiss"].mockRejectedValue(failure);
    const first = createObservedDialogAbortSignalForPage({ page });
    const second = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept, timeoutMs: 1000 });
    emit("dialog", dialog);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(first.signal.reason).toBe(failure);
    expect(second.signal.reason).toBe(failure);
    expect(dialogs()).toEqual({ pending: [], recent: [] });
    await expect(respondToObservedDialogOnPage({ page, dialogId: "d1", accept })).rejects.toThrow(
      'Dialog "d1" is not pending.',
    );
    first.cleanup();
    second.cleanup();
  });

  it("uses the default arm-next-dialog timeout for non-finite timeoutMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { page, emit, dialogs } = createPageHarness();
    const dialog = createDialog({ type: "alert", message: "Still armed" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: Number.NaN });
    await vi.advanceTimersByTimeAsync(119_999);
    emit("dialog", dialog);
    await Promise.resolve();

    expect(observed.signal.aborted).toBe(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(dialogs()).toMatchObject({
      pending: [],
      recent: [{ id: "d1", type: "alert", closedBy: "armed" }],
    });
    observed.cleanup();
  });

  it("does not arm next-dialog responses when the expiry would overflow Date bounds", () => {
    vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    const { page, emit, dialogs } = createPageHarness();
    const dialog = createDialog({ type: "alert", message: "Still pending" });
    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
    emit("dialog", dialog);
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(dialogs().pending).toMatchObject([
      { id: "d1", type: "alert", message: "Still pending" },
    ]);
  });

  it("keeps a newer dialog pending after the interrupted dialog was handled remotely", async () => {
    const { page, emit, dialogs } = createPageHarness();
    const observed = createObservedDialogAbortSignalForPage({ page });
    const first = createDialog({ message: "First" });
    emit("dialog", first);
    expect(observed.signal.aborted).toBe(true);
    expect(isBrowserObservedDialogBlockedError(observed.signal.reason)).toBe(true);
    expect(dialogs().pending).toMatchObject([{ id: "d1", message: "First" }]);
    expect(first.dismiss).not.toHaveBeenCalled();
    const next = createDialog({ message: "Second" });
    emit("dialog", next);

    reconcileRemoteDialogAfterActionSettled(page, observed.signal);

    expect(dialogs()).toMatchObject({
      pending: [{ id: "d2", message: "Second" }],
      recent: [{ id: "d1", closedBy: "remote" }],
    });
    await respondToObservedDialogOnPage({ page, dialogId: "d2", accept: false });
    expect(next.dismiss).toHaveBeenCalledOnce();
    expect(dialogs()).toMatchObject({
      pending: [],
      recent: [
        { id: "d1", closedBy: "remote" },
        { id: "d2", closedBy: "agent" },
      ],
    });
    observed.cleanup();
  });
});
