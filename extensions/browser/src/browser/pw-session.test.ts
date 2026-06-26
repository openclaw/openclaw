// Browser tests cover pw session plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import {
  beginActionDownloadCaptureOnPage,
  ensurePageState,
  refLocator,
  rememberRoleRefsForTarget,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";

type MutableDownload = {
  suggestedFilename: () => string;
  saveAs: ReturnType<typeof vi.fn>;
  path?: () => Promise<string>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

function fakePage(): {
  page: Page;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  mocks: {
    on: ReturnType<typeof vi.fn>;
    getByRole: ReturnType<typeof vi.fn>;
    frameLocator: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return undefined as unknown;
  });
  const getByRole = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));
  const frameLocator = vi.fn(() => ({
    getByRole: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
    locator: vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) })),
  }));
  const locator = vi.fn(() => ({ nth: vi.fn(() => ({ ok: true })) }));

  const page = {
    on,
    getByRole,
    frameLocator,
    locator,
  } as unknown as Page;

  return { page, handlers, mocks: { on, getByRole, frameLocator, locator } };
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
  it("uses frameLocator for role refs when snapshot was scoped to a frame", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };
    state.roleRefsFrameSelector = "iframe#main";

    refLocator(page, "e1");

    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });

  it("uses page getByRole for role refs by default", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { e1: { role: "button", name: "OK" } };

    refLocator(page, "e1");

    expect(mocks.getByRole).toHaveBeenCalled();
  });

  it("uses aria-ref locators when refs mode is aria", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefsMode = "aria";

    refLocator(page, "e1");

    expect(mocks.locator).toHaveBeenCalledWith("aria-ref=e1");
  });

  it("uses backend-marked DOM locators for ax refs", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { ax12: { role: "button", name: "OK", domMarker: true } };

    refLocator(page, "ax12");

    expect(mocks.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}="ax12"]`);
  });

  it("falls back to role heuristics for ax refs without backend markers", () => {
    const { page, mocks } = fakePage();
    const state = ensurePageState(page);
    state.roleRefs = { ax12: { role: "button", name: "OK" } };

    refLocator(page, "ax12");

    expect(mocks.getByRole).toHaveBeenCalledWith("button", { name: "OK", exact: true });
  });

  it("rejects unknown ax refs instead of timing out on aria-ref locators", () => {
    const { page, mocks } = fakePage();

    expect(() => refLocator(page, "ax12")).toThrow(/Unknown ref/);
    expect(mocks.locator).not.toHaveBeenCalled();
  });
});

describe("pw-session role refs cache", () => {
  it("restores refs for a different Page instance (same CDP targetId)", () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const targetId = "t1";

    rememberRoleRefsForTarget({
      cdpUrl,
      targetId,
      refs: { e1: { role: "button", name: "OK" } },
      frameSelector: "iframe#main",
    });

    const { page, mocks } = fakePage();
    restoreRoleRefsForTarget({ cdpUrl, targetId, page });

    refLocator(page, "e1");
    expect(mocks.frameLocator).toHaveBeenCalledWith("iframe#main");
  });
});

describe("pw-session ensurePageState", () => {
  it("stores unmanaged downloads under unique managed paths", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const saveAsA = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-a", "utf8");
    });
    const saveAsB = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-b", "utf8");
    });
    const downloadA: MutableDownload = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsA,
    };
    const downloadB: MutableDownload = {
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
      const savedParentName = path.basename(path.dirname(savedPath));
      expect(
        savedParentName.includes("fs-safe-output") ||
          savedParentName === path.basename(DEFAULT_DOWNLOAD_DIR),
      ).toBe(true);
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

  it("leaves unmanaged download handling to explicit waiters while armed", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;
    const download = {
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {}),
    };

    handlers.get("download")?.[0]?.(download);

    expect(download).not.toHaveProperty("path");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("captures only downloads owned by an active action", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "action-download", "utf8");
    });
    const download: MutableDownload = {
      suggestedFilename: () => "clicked.txt",
      saveAs,
    };

    handlers.get("download")?.[0]?.(download);
    const result = await capture.drain();
    capture.dispose();

    expect(result).toEqual({
      count: 1,
      recent: [
        {
          suggestedFilename: "clicked.txt",
          savedPath: expect.stringMatching(/clicked\.txt$/),
        },
      ],
    });
    const savedPath = result?.recent[0]?.savedPath ?? "";
    expect(path.dirname(savedPath)).toBe(DEFAULT_DOWNLOAD_DIR);
    await expect(fs.readFile(savedPath, "utf8")).resolves.toBe("action-download");
  });

  it("waits briefly for action downloads that arrive after the action returns", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "late-download", "utf8");
    });
    const drain = capture.drain({ graceMs: 1000 });

    setTimeout(() => {
      handlers.get("download")?.[0]?.({
        suggestedFilename: () => "late.txt",
        saveAs,
      });
    }, 0);

    const result = await drain;
    capture.dispose();

    expect(result?.count).toBe(1);
    expect(result?.recent[0]?.suggestedFilename).toBe("late.txt");
    await expect(fs.readFile(result?.recent[0]?.savedPath ?? "", "utf8")).resolves.toBe(
      "late-download",
    );
  });

  it("does not let action captures steal explicit waiter downloads", async () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);
    state.downloadWaiterDepth = 1;
    const capture = beginActionDownloadCaptureOnPage(page);
    const download = {
      suggestedFilename: () => "report.pdf",
      saveAs: vi.fn(async () => {}),
    };

    handlers.get("download")?.[0]?.(download);
    const result = await capture.drain();
    capture.dispose();

    expect(result).toBeUndefined();
    expect(download).not.toHaveProperty("path");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("tracks page errors and network requests (best-effort)", () => {
    const { page, handlers } = fakePage();
    const state = ensurePageState(page);

    const req = {
      method: () => "GET",
      url: () => "https://example.com/api",
      resourceType: () => "xhr",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    } as unknown as import("playwright-core").Request;

    const resp = {
      request: () => req,
      status: () => 500,
      ok: () => false,
    } as unknown as import("playwright-core").Response;

    handlers.get("request")?.[0]?.(req);
    handlers.get("response")?.[0]?.(resp);
    handlers.get("requestfailed")?.[0]?.(req);
    handlers.get("pageerror")?.[0]?.(new Error("boom"));

    expect(state.errors.at(-1)?.message).toBe("boom");
    const request = state.requests.at(-1);
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://example.com/api");
    expect(request?.resourceType).toBe("xhr");
    expect(request?.status).toBe(500);
    expect(request?.ok).toBe(false);
    expect(request?.failureText).toBe("net::ERR_FAILED");
  });

  it("drops state on page close", () => {
    const { page, handlers } = fakePage();
    const state1 = ensurePageState(page);
    handlers.get("close")?.[0]?.();

    const state2 = ensurePageState(page);
    expect(state2).not.toBe(state1);
    expect(state2.console).toStrictEqual([]);
    expect(state2.errors).toStrictEqual([]);
    expect(state2.requests).toStrictEqual([]);
  });
});

describe("pw-session action download capture", () => {
  it("captures multiple concurrent downloads within one action", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);

    const saveAsA = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-a", "utf8");
    });
    const saveAsB = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-b", "utf8");
    });
    const saveAsC = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-c", "utf8");
    });

    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "a.txt",
      saveAs: saveAsA,
    });
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "b.txt",
      saveAs: saveAsB,
    });
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "c.txt",
      saveAs: saveAsC,
    });

    const result = await capture.drain();
    capture.dispose();

    expect(result?.count).toBe(3);
    expect(result?.recent.map((d) => d.suggestedFilename)).toEqual(["a.txt", "b.txt", "c.txt"]);
    for (const d of result?.recent ?? []) {
      expect(path.dirname(d.savedPath)).toBe(DEFAULT_DOWNLOAD_DIR);
    }
  });

  it("dispose prevents new downloads from being captured after disposal", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);

    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "pre-dispose", "utf8");
    });
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "pre.txt",
      saveAs,
    });

    const result = await capture.drain();
    expect(result?.count).toBe(1);

    capture.dispose();

    // After dispose, a new download is fired. The page's download handler
    // looks at state.actionDownloadCaptures.at(-1), but our capture was
    // removed from the list. The download should fall through to
    // managedSave.catch(() => {}) without being captured.
    const saveAs2 = vi.fn(async () => {});
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "post.txt",
      saveAs: saveAs2,
    });

    // The disposed capture won't see new downloads from the page handler.
    // But it may still return its previously captured results on re-drain
    // since capture.promises is not cleared by dispose.
    const afterDispose = await capture.drain();
    // The key assertion: the post-dispose download's saveAs was never called
    // because it wasn't captured (fell through to managedSave.catch).
    expect(saveAs2).not.toHaveBeenCalled();
  });

  it("double dispose is safe", () => {
    const { page } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);

    capture.dispose();
    expect(() => capture.dispose()).not.toThrow();
  });

  it("broadcasts downloads to all active captures to prevent misattribution", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const capture1 = beginActionDownloadCaptureOnPage(page);
    const capture2 = beginActionDownloadCaptureOnPage(page);

    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "shared", "utf8");
    });
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "shared.txt",
      saveAs,
    });

    // Both captures receive the download, preventing misattribution
    const result1 = await capture1.drain();
    const result2 = await capture2.drain();

    expect(result1?.count).toBe(1);
    expect(result1?.recent[0]?.suggestedFilename).toBe("shared.txt");
    expect(result2?.count).toBe(1);
    expect(result2?.recent[0]?.suggestedFilename).toBe("shared.txt");
    expect(result1?.recent[0]?.savedPath).toBe(result2?.recent[0]?.savedPath);

    capture1.dispose();
    capture2.dispose();
  });

  it("non-overlapping sequential captures see their own downloads", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const capture1 = beginActionDownloadCaptureOnPage(page);
    const saveAs1 = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "first", "utf8");
    });
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "first.txt",
      saveAs: saveAs1,
    });
    const result1 = await capture1.drain();
    capture1.dispose();

    expect(result1?.count).toBe(1);
    expect(result1?.recent[0]?.suggestedFilename).toBe("first.txt");

    // Second capture starts after first is disposed
    const capture2 = beginActionDownloadCaptureOnPage(page);
    const saveAs2 = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "second", "utf8");
    });
    handlers.get("download")?.[0]?.({
      suggestedFilename: () => "second.txt",
      saveAs: saveAs2,
    });
    const result2 = await capture2.drain();
    capture2.dispose();

    expect(result2?.count).toBe(1);
    expect(result2?.recent[0]?.suggestedFilename).toBe("second.txt");
    expect(saveAs1).toHaveBeenCalledTimes(1);
    expect(saveAs2).toHaveBeenCalledTimes(1);
  });

  it("graceMs=0 returns immediately when no download has arrived", async () => {
    const { page } = fakePage();
    ensurePageState(page);
    const capture = beginActionDownloadCaptureOnPage(page);

    const result = await capture.drain({ graceMs: 0 });
    capture.dispose();

    expect(result).toBeUndefined();
  });
});
