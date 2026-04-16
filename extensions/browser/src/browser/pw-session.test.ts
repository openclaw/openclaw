import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import {
  ensurePageState,
  refLocator,
  rememberRoleRefsForTarget,
  restoreRoleRefsForTarget,
} from "./pw-session.js";

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
    expect(state.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://example.com/api",
      resourceType: "xhr",
      status: 500,
      ok: false,
      failureText: "net::ERR_FAILED",
    });
  });

  it("stores unmanaged downloads under unique managed paths", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const saveAsA = vi.fn(async () => {});
    const saveAsB = vi.fn(async () => {});
    const downloadA = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsA,
    };
    const downloadB = {
      suggestedFilename: () => "report.pdf",
      saveAs: saveAsB,
    };

    handlers.get("download")?.[0]?.(downloadA);
    handlers.get("download")?.[0]?.(downloadB);

    const pathA = await (downloadA as { path?: () => Promise<string> }).path?.();
    const pathB = await (downloadB as { path?: () => Promise<string> }).path?.();

    expect(mkdirSpy).toHaveBeenCalledWith(DEFAULT_DOWNLOAD_DIR, { recursive: true });
    expect(pathA).toBeTruthy();
    expect(pathB).toBeTruthy();
    expect(pathA).not.toBe(pathB);
    expect(path.dirname(pathA ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.dirname(pathB ?? "")).toBe(DEFAULT_DOWNLOAD_DIR);
    expect(path.basename(pathA ?? "")).toMatch(/-report\.pdf$/);
    expect(path.basename(pathB ?? "")).toMatch(/-report\.pdf$/);
    expect(saveAsA).toHaveBeenCalledWith(pathA);
    expect(saveAsB).toHaveBeenCalledWith(pathB);

    mkdirSpy.mockRestore();
  });

  it("suppresses unhandled rejections while still surfacing save failures via path()", async () => {
    const { page, handlers } = fakePage();
    ensurePageState(page);

    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const rejectionEvents: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      rejectionEvents.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const download = {
        suggestedFilename: () => "broken.bin",
        saveAs: vi.fn(async () => {
          throw new Error("save failed");
        }),
      };

      handlers.get("download")?.[0]?.(download);
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      await expect((download as { path?: () => Promise<string> }).path?.()).rejects.toThrow(
        "save failed",
      );
      expect(rejectionEvents).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      mkdirSpy.mockRestore();
    }
  });

  it("drops state on page close", () => {
    const { page, handlers } = fakePage();
    const state1 = ensurePageState(page);
    handlers.get("close")?.[0]?.();

    const state2 = ensurePageState(page);
    expect(state2).not.toBe(state1);
    expect(state2.console).toEqual([]);
    expect(state2.errors).toEqual([]);
    expect(state2.requests).toEqual([]);
  });
});
