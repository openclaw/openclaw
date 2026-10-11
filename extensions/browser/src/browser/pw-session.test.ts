import fs from "node:fs/promises";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type { Dialog, Frame, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { pwAi } from "./pw-ai.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  armObservedDialogResponseOnPage,
  beginActionDownloadCaptureOnPage,
  ensurePageState,
  isDownloadStartingNavigationError,
  refLocator,
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
});

function fakePage() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return undefined as unknown;
  });
  const off = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    handlers.set(
      event,
      list.filter((handler) => handler !== cb),
    );
    return undefined as unknown;
  });
  const getByRole = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const frameLocator = vi.fn(() => ({
    getByRole: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
    locator: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
  }));
  const frameGetByRole = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const frameQuery = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const selectedFrame = {
    url: () => "https://frame.example.com",
    getByRole: frameGetByRole,
    locator: frameQuery,
  } as unknown as Frame;
  const locator = vi.fn(() => ({
    nth: vi.fn(() => ({ ok: true })),
    elementHandle: vi.fn(async () => ({
      contentFrame: vi.fn(async () => selectedFrame),
    })),
  }));

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
    handlers,
    mainFrame,
    selectedFrame,
    mocks: { on, frameGetByRole, frameQuery, getByRole, frameLocator, locator },
  };
}

function saveContents(contents: string) {
  return vi.fn(async (outPath: string) => {
    await fs.writeFile(outPath, contents, "utf8");
  });
}

function firstSavePath(saveAs: MutableDownload["saveAs"]): string {
  const [call] = saveAs.mock.calls;
  if (!call) {
    throw new Error("Expected saveAs call");
  }
  const [savedPath] = call;
  if (typeof savedPath !== "string") {
    throw new Error("Expected saved download path");
  }
  return savedPath;
}

describe("pw-session refLocator", () => {
  it("matches empty accessibility names in the captured snapshot Frame", () => {
    const ref = "ax12";
    const name = "";
    const { page, selectedFrame, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { [ref]: { role: "button", name } };
    state.roleRefsFrame = selectedFrame;

    refLocator(page, ref);

    expect(mocks.frameGetByRole).toHaveBeenCalledWith("button", { name, exact: true });
    expect(mocks.getByRole).not.toHaveBeenCalled();
    expect(mocks.frameLocator).not.toHaveBeenCalled();
  });

  it("uses aria-ref locators when refs mode is aria", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefsMode = "aria";

    refLocator(page, "e1");

    expect(mocks.locator).toHaveBeenCalledWith("aria-ref=e1");
  });

  it("uses backend-marked DOM locators for role refs", () => {
    const ref = "e1";
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { [ref]: { role: "button", name: "OK", domMarker: true } };

    refLocator(page, ref);

    expect(mocks.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${ref}"]`);
  });

  it("rejects unknown ax refs instead of timing out on aria-ref locators", () => {
    const { page, mocks } = fakePage();

    expect(() => refLocator(page, "ax12")).toThrow(/Unknown ref/);
    expect(mocks.locator).not.toHaveBeenCalled();
  });
});

describe("pw-session role refs cache", () => {
  it("restores fresh post-navigation refs for a replacement Page", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    const { page: pageA, handlers, mainFrame } = fakePage();
    storeRoleRefsForTarget({
      page: pageA,
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "Page A" } },
      mode: "role",
    });
    handlers.get("framenavigated")?.[0]?.(mainFrame);
    expect(ensurePageState(pageA).roleRefs).toBeUndefined();

    storeRoleRefsForTarget({
      page: pageA,
      cdpUrl,
      targetId,
      refs: { e1: { role: "heading", name: "Page B" } },
      mode: "aria",
    });

    const { page: pageB } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page: pageB });
    expect(ensurePageState(pageB).roleRefs).toEqual({
      e1: { role: "heading", name: "Page B" },
    });
    expect(ensurePageState(pageB).roleRefsMode).toBe("aria");
  });

  it("invalidates page-wide aria refs on subframe navigation", () => {
    const event = "framenavigated";
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = `aria-target-${event}`;
    const { page, handlers } = fakePage();
    storeRoleRefsForTarget({
      page,
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "Embedded" } },
      mode: "aria",
    });

    handlers.get(event)?.[0]?.({ url: () => "https://frame.example/new" });

    expect(ensurePageState(page).roleRefs).toBeUndefined();
    const { page: replacementPage } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page: replacementPage });
    expect(ensurePageState(replacementPage).roleRefs).toBeUndefined();
  });
});

describe("pw-session ensurePageState", () => {
  it("stores unmanaged downloads under unique managed paths", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const saveAsA = saveContents("download-a");
    const saveAsB = saveContents("download-b");
    const downloadA: MutableDownload = {
      url: () => "",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsA,
    };
    const downloadB: MutableDownload = {
      url: () => "",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsB,
    };

    handlers.get("download")?.[0]?.(downloadA);
    handlers.get("download")?.[0]?.(downloadB);

    const managedPathA = await downloadA.path?.();
    const managedPathB = await downloadB.path?.();

    expect(managedPathA).not.toBe(managedPathB);
    expect(path.dirname(managedPathA ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.dirname(managedPathB ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(managedPathA ?? "")).toMatch(/-report\.pdf$/);
    expect(path.basename(managedPathB ?? "")).toMatch(/-report\.pdf$/);
    const savedPathA = firstSavePath(saveAsA);
    const savedPathB = firstSavePath(saveAsB);
    expect(savedPathA).not.toBe(managedPathA);
    expect(savedPathB).not.toBe(managedPathB);
    for (const savedPath of [savedPathA, savedPathB]) {
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
    const { page, handlers } = fakePage();
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    ensurePageState(page);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const err = new Error("save failed");
    const download: MutableDownload = {
      url: () => "",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {
        throw err;
      }),
    };

    try {
      handlers.get("download")?.[0]?.(download);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandled).toStrictEqual([]);
      await expect(download.path?.()).rejects.toThrow("save failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("waits only the requested first-event grace for a just-late action download", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const saveAs = saveContents("late-action-download");
    const drain = capture.drain({ firstEventGraceMs: 1_000 });

    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "https://example.com/late.txt",
        cancel: vi.fn(async () => {}),
        suggestedFilename: () => "late.txt",
        saveAs,
      });
    });

    await expect(drain).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "late.txt" }),
    ]);
    capture.dispose();
  });

  it("detaches ownership before waiting for slow file saves", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const beforeSave = vi.fn(async () => {});
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const firstSave = vi.fn(async (outPath: string) => {
      await firstSaveGate;
      await fs.writeFile(outPath, "first", "utf8");
    });
    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/first.txt",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "first.txt",
      saveAs: firstSave,
    });

    const drain = capture.drain();
    const lateSave = saveContents("late");
    const lateDownload: MutableDownload = {
      url: () => "https://example.com/late.txt",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "late.txt",
      saveAs: lateSave,
    };
    handlers.get("download")?.[0]?.(lateDownload);
    releaseFirstSave?.();

    await expect(drain).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "first.txt" }),
    ]);
    await expect(lateDownload.path?.()).resolves.toMatch(/-late\.txt$/);
    expect(beforeSave).toHaveBeenCalledOnce();
    expect(lateSave).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("keeps started saves with their owner and assigns future downloads to the latest action", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const first = beginActionDownloadCaptureOnPage(page);
    const firstSaveAs = saveContents("first-action-download");
    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/first.txt",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "first.txt",
      saveAs: firstSaveAs,
    });

    const latest = beginActionDownloadCaptureOnPage(page);
    first.dispose();
    const latestSaveAs = saveContents("latest-action-download");
    handlers.get("download")?.[0]?.({
      url: () => "https://example.com/latest.txt",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "latest.txt",
      saveAs: latestSaveAs,
    });

    await expect(first.drain()).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "first.txt" }),
    ]);
    await expect(latest.drain()).resolves.toEqual([
      expect.objectContaining({ suggestedFilename: "latest.txt" }),
    ]);
    latest.dispose();
    expect(firstSaveAs).toHaveBeenCalledOnce();
    expect(latestSaveAs).toHaveBeenCalledOnce();
  });

  it("leaves action capture empty while an explicit download owner is armed", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;
    const capture = beginActionDownloadCaptureOnPage(page);
    const download = {
      url: () => "",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "explicit.txt",
      saveAs: vi.fn(async () => {}),
    };

    handlers.get("download")?.[0]?.(download);

    await expect(capture.drain()).resolves.toBeUndefined();
    capture.dispose();
    expect(download).not.toHaveProperty("path");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("drains late siblings before surfacing the first download policy failure", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const blocked = new Error("blocked action download");
    const beforeSave = vi.fn(async () => {
      throw blocked;
    });
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    const firstSave = vi.fn(async () => {});
    const secondSave = vi.fn(async () => {});

    handlers.get("download")?.[0]?.({
      url: () => "http://127.0.0.1/first.txt",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "first.txt",
      saveAs: firstSave,
    });
    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "http://127.0.0.1/second.txt",
        cancel: vi.fn(async () => {}),
        suggestedFilename: () => "second.txt",
        saveAs: secondSave,
      });
    });

    await expect(capture.drain({ quietMs: 1_000 })).rejects.toBe(blocked);
    capture.dispose();
    expect(beforeSave).toHaveBeenCalledTimes(2);
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).not.toHaveBeenCalled();
  });

  it("surfaces a sibling policy denial without waiting for an allowed slow save", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const blocked = new Error("blocked sibling download");
    const beforeSave = vi.fn(async (candidate: { url: string }) => {
      if (candidate.url.endsWith("/blocked.txt")) {
        throw blocked;
      }
    });
    const capture = beginActionDownloadCaptureOnPage(page, { beforeSave });
    let releaseAllowedSave: (() => void) | undefined;
    const allowedSaveGate = new Promise<void>((resolve) => {
      releaseAllowedSave = resolve;
    });
    const allowedDownload: MutableDownload = {
      url: () => "https://example.com/allowed.txt",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "allowed.txt",
      saveAs: vi.fn(async (outPath: string) => {
        await allowedSaveGate;
        await fs.writeFile(outPath, "allowed", "utf8");
      }),
    };
    handlers.get("download")?.[0]?.(allowedDownload);
    setImmediate(() => {
      handlers.get("download")?.[0]?.({
        url: () => "https://example.com/blocked.txt",
        cancel: vi.fn(async () => {}),
        suggestedFilename: () => "blocked.txt",
        saveAs: vi.fn(async () => {}),
      });
    });

    await expect(capture.drain({ quietMs: 100 })).rejects.toBe(blocked);
    releaseAllowedSave?.();
    await expect(allowedDownload.path?.()).resolves.toMatch(/-allowed\.txt$/);
    capture.dispose();
  });

  it("surfaces action-owned download save failures without an unhandled rejection", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const error = new Error("action download save failed");
    const cancel = vi.fn(async () => {
      throw new Error("browser disconnected during cancellation");
    });

    handlers.get("download")?.[0]?.({
      url: () => "",
      suggestedFilename: () => "failed.txt",
      saveAs: vi.fn(async () => {
        throw error;
      }),
      cancel,
    });

    await expect(capture.drain()).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("captures navigation downloads under managed paths", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    const capture = createDownloadCaptureForPage(page, state, 1_000);
    const saveAs = saveContents("attachment");
    const download = {
      url: () => "https://example.com/export.csv",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "export.csv",
      saveAs,
    };

    for (const handler of handlers.get("download") ?? []) {
      handler(download);
    }

    const result = await capture.promise;
    expect(result.url).toBe("https://example.com/export.csv");
    expect(result.suggestedFilename).toBe("export.csv");
    expect(path.dirname(result.path)).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(result.path)).toMatch(/-export\.csv$/);
    expect(firstSavePath(saveAs)).not.toBe(result.path);
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("attachment");
  });

  it("validates captured navigation downloads before saving managed bytes", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    const blocked = new Error("blocked download");
    const beforeSave = vi.fn(async () => {
      throw blocked;
    });
    const capture = createDownloadCaptureForPage(page, state, 1_000, { beforeSave });
    const saveAs = saveContents("blocked");
    const download = {
      url: () => "http://127.0.0.1:18080/export.csv",
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => "export.csv",
      saveAs,
    };

    for (const handler of handlers.get("download") ?? []) {
      handler(download);
    }

    await expect(capture.promise).rejects.toBe(blocked);
    expect(beforeSave).toHaveBeenCalledWith({
      url: "http://127.0.0.1:18080/export.csv",
      suggestedFilename: "export.csv",
    });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("lets explicit download owners arm while passive capture yields", () => {
    const { page } = fakePage();
    const state = ensurePageState(page);
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
    expect(isDownloadStartingNavigationError(new Error("page.goto: Download is starting"))).toBe(
      true,
    );
    expect(isDownloadStartingNavigationError(new Error("page.goto: net::ERR_ABORTED"))).toBe(false);
    expect(
      isDownloadStartingNavigationError(
        new Error("page.goto: net::ERR_ABORTED at http://127.0.0.1:3333/download"),
        "http://127.0.0.1:3333/download",
      ),
    ).toBe(true);
    expect(
      isDownloadStartingNavigationError(
        new Error("page.goto: net::ERR_ABORTED at http://127.0.0.1:3333/other"),
        "http://127.0.0.1:3333/download",
      ),
    ).toBe(false);
    expect(isDownloadStartingNavigationError(new Error("Navigation failed"))).toBe(false);
  });

  it("bounds page-controlled text while tracking network requests", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);

    const oversized = `${"x".repeat(2047)}😀tail`;
    const consoleMessage = {
      type: () => oversized,
      text: () => oversized,
      location: () => ({ url: oversized, lineNumber: 1, columnNumber: 2 }),
    } as unknown as import("playwright-core").ConsoleMessage;
    const pageError = new Error(oversized);
    pageError.name = oversized;
    pageError.stack = oversized;

    const req = {
      method: () => "GET",
      url: () => oversized,
      resourceType: () => "xhr",
      failure: () => ({ errorText: oversized }),
    } as unknown as import("playwright-core").Request;

    const resp = {
      request: () => req,
      status: () => 500,
      ok: () => false,
    } as unknown as import("playwright-core").Response;

    handlers.get("request")?.[0]?.(req);
    handlers.get("response")?.[0]?.(resp);
    handlers.get("requestfailed")?.[0]?.(req);
    handlers.get("console")?.[0]?.(consoleMessage);
    handlers.get("pageerror")?.[0]?.(pageError);

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
    expect(request?.method).toBe("GET");
    expect(request?.resourceType).toBe("xhr");
    expect(request?.status).toBe(500);
    expect(request?.ok).toBe(false);
  });

  it("clears frame-scoped role refs on frame detachment", () => {
    const { page, handlers, selectedFrame } = fakePage();
    const state = ensurePageState(page);

    storeRoleRefsForTarget({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "t1",
      refs: { e1: { role: "button", name: "Inside frame" } },
      frameSelector: "iframe#content",
      frame: selectedFrame,
      mode: "role",
    });

    handlers.get("framedetached")?.[0]?.({ url: () => "https://ads.example.com" });
    expect(state.roleRefs).toBeDefined();

    handlers.get("framedetached")?.[0]?.(selectedFrame);
    expect(state.roleRefs).toBeUndefined();
    expect(state.roleRefsFrame).toBeUndefined();
  });
});

const {
  createObservedDialogAbortSignalForPage,
  getObservedBrowserStateForPage,
  isBrowserObservedDialogBlockedError,
  respondToObservedDialogOnPage,
} = pwAi;

type Handler = (arg: unknown) => void;

function createPageHarness() {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
  };
  const observedPage = page as unknown as Page;
  ensurePageState(observedPage);
  return {
    page: observedPage,
    emit: (event: string, arg: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(arg);
      }
    },
  };
}

function createDialog(
  overrides: Partial<{
    type: string;
    message: string;
    defaultValue: string;
  }> = {},
) {
  return {
    type: vi.fn(() => overrides.type ?? "confirm"),
    message: vi.fn(() => overrides.message ?? "Continue?"),
    defaultValue: vi.fn(() => overrides.defaultValue ?? ""),
    accept: vi.fn(async (_promptText?: string) => {}),
    dismiss: vi.fn(async () => {}),
  } as unknown as Dialog & {
    accept: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };
}

describe("observed browser dialogs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces pending dialogs and lets callers respond by id", async () => {
    const { page, emit } = createPageHarness();
    const dialog = createDialog({ message: "Ship it?" });

    emit("dialog", dialog);

    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", type: "confirm", message: "Ship it?" },
    ]);

    const closed = await respondToObservedDialogOnPage({
      page,
      dialogId: "d1",
      accept: true,
      promptText: "yes",
    });

    expect(dialog.accept).toHaveBeenCalledWith("yes");
    expect(closed.closedBy).toBe("agent");
    expect(closed).not.toHaveProperty("dialog");
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", closedBy: "agent" },
    ]);
  });

  it("aborts every in-flight action and consumes a failed armed dialog", async () => {
    const accept = true;
    const { page, emit } = createPageHarness();
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
    expect(getObservedBrowserStateForPage(page).dialogs).toEqual({ pending: [], recent: [] });
    await expect(respondToObservedDialogOnPage({ page, dialogId: "d1", accept })).rejects.toThrow(
      'Dialog "d1" is not pending.',
    );
    first.cleanup();
    second.cleanup();
  });

  it("records an already-closed dialog as remotely handled", async () => {
    const accept = false;
    const { page, emit } = createPageHarness();
    const dialog = createDialog();
    dialog[accept ? "accept" : "dismiss"].mockRejectedValue(
      new Error("Protocol error: No dialog is showing"),
    );
    emit("dialog", dialog);

    const closed = await respondToObservedDialogOnPage({ page, dialogId: "d1", accept });

    expect(closed.closedBy).toBe("remote");
    expect(getObservedBrowserStateForPage(page).dialogs).toMatchObject({
      pending: [],
      recent: [{ id: "d1", closedBy: "remote" }],
    });
  });

  it("uses the default arm-next-dialog timeout for non-finite timeoutMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { page, emit } = createPageHarness();
    const dialog = createDialog({ type: "alert", message: "Still armed" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: Number.NaN });
    await vi.advanceTimersByTimeAsync(119_999);
    emit("dialog", dialog);
    await Promise.resolve();

    expect(observed.signal.aborted).toBe(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "armed" },
    ]);
    observed.cleanup();
  });

  it("does not arm next-dialog responses when the expiry would overflow Date bounds", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
      const { page, emit } = createPageHarness();
      const dialog = createDialog({ type: "alert", message: "Still pending" });

      armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
      emit("dialog", dialog);

      expect(dialog.dismiss).not.toHaveBeenCalled();
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
        { id: "d1", type: "alert", message: "Still pending" },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps a newer dialog pending after the interrupted dialog was handled remotely", async () => {
    const { page, emit } = createPageHarness();
    const observed = createObservedDialogAbortSignalForPage({ page });
    const first = createDialog({ message: "First" });
    emit("dialog", first);
    expect(observed.signal.aborted).toBe(true);
    expect(isBrowserObservedDialogBlockedError(observed.signal.reason)).toBe(true);
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", message: "First" },
    ]);
    expect(first.dismiss).not.toHaveBeenCalled();
    const next = createDialog({ message: "Second" });
    emit("dialog", next);

    reconcileRemoteDialogAfterActionSettled(page, observed.signal);

    expect(getObservedBrowserStateForPage(page).dialogs).toMatchObject({
      pending: [{ id: "d2", message: "Second" }],
      recent: [{ id: "d1", closedBy: "remote" }],
    });
    await respondToObservedDialogOnPage({ page, dialogId: "d2", accept: false });
    expect(next.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs).toMatchObject({
      pending: [],
      recent: [
        { id: "d1", closedBy: "remote" },
        { id: "d2", closedBy: "agent" },
      ],
    });
    observed.cleanup();
  });
});
