// Browser tests cover pw tools core.screenshots element selector plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const navigationGuardMocks = getPwToolsCoreNavigationGuardMocks();
const mod = await import("./pw-tools-core.js");

type FrameListener = (frame: { url: () => string }) => void;

function createNavigationAwarePage(initialUrl = "https://safe.example/start") {
  let currentUrl = initialUrl;
  const listeners = new Set<FrameListener>();
  const frame = { url: vi.fn(() => currentUrl) };
  return {
    listeners,
    navigate(nextUrl: string) {
      currentUrl = nextUrl;
      for (const listener of listeners) {
        listener(frame);
      }
    },
    page: {
      url: vi.fn(() => currentUrl),
      on: vi.fn((event: string, listener: FrameListener) => {
        if (event === "framenavigated") {
          listeners.add(listener);
        }
      }),
      off: vi.fn((event: string, listener: FrameListener) => {
        if (event === "framenavigated") {
          listeners.delete(listener);
        }
      }),
    },
  };
}

function createBlockedNavigationError() {
  const error = new Error("Navigation blocked by SSRF policy");
  error.name = "SsrFBlockedError";
  return error;
}

function createFileChooserPageMocks() {
  const fileChooser = { setFiles: vi.fn(async () => {}) };
  const press = vi.fn(async () => {});
  const waitForEvent = vi.fn(async () => fileChooser);
  setPwToolsCoreCurrentPage({
    waitForEvent,
    keyboard: { press },
  });
  return { fileChooser, press, waitForEvent };
}

describe("pw-tools-core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("screenshots an element selector", async () => {
    const elementScreenshot = vi.fn(async () => Buffer.from("E"));
    const page = {
      locator: vi.fn(() => ({
        first: () => ({ screenshot: elementScreenshot }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };
    setPwToolsCoreCurrentPage(page);

    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      element: "#main",
      type: "png",
      timeoutMs: 1234,
    });

    expect(res.buffer.toString()).toBe("E");
    expect(sessionMocks.getPageForTargetId).toHaveBeenCalled();
    expect(page.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(elementScreenshot).toHaveBeenCalledWith({ type: "png", timeout: 1234 });
  });
  it("screenshots a ref locator", async () => {
    const refScreenshot = vi.fn(async () => Buffer.from("R"));
    setPwToolsCoreCurrentRefLocator({ screenshot: refScreenshot });
    const page = {
      locator: vi.fn(),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };
    setPwToolsCoreCurrentPage(page);

    const res = await mod.takeScreenshotViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "76",
      type: "jpeg",
      timeoutMs: 2345,
    });

    expect(res.buffer.toString()).toBe("R");
    expect(sessionMocks.refLocator).toHaveBeenCalledWith(page, "76");
    expect(refScreenshot).toHaveBeenCalledWith({ type: "jpeg", timeout: 2345 });
  });
  it.each([
    { name: "viewport", fullPage: false },
    { name: "full-page", fullPage: true },
  ])("guards a safe $name screenshot through the full navigation window", async ({ fullPage }) => {
    vi.useFakeTimers();
    try {
      const navigation = createNavigationAwarePage();
      const screenshot = vi.fn(async () => Buffer.from("SAFE"));
      const page = { ...navigation.page, screenshot };
      setPwToolsCoreCurrentPage(page);

      const task = mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        fullPage,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(screenshot).toHaveBeenCalledWith({
        type: "png",
        fullPage,
        timeout: undefined,
      });
      expect(navigation.listeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      await expect(task).resolves.toMatchObject({ buffer: Buffer.from("SAFE") });
      expect(navigation.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { name: "viewport", fullPage: false },
    { name: "full-page", fullPage: true },
  ])("rejects a blocked navigation triggered by a $name screenshot", async ({ fullPage }) => {
    vi.useFakeTimers();
    try {
      const navigation = createNavigationAwarePage();
      const screenshot = vi.fn(async () => {
        navigation.navigate("http://169.254.169.254/latest/meta-data");
        return Buffer.from("BLOCKED");
      });
      const page = { ...navigation.page, screenshot };
      const blockedError = createBlockedNavigationError();
      sessionMocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(blockedError);
      setPwToolsCoreCurrentPage(page);

      const task = mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        fullPage,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toBe(blockedError);

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith(
        expect.objectContaining({ error: blockedError, page, targetId: "T1" }),
      );
      expect(navigation.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rechecks the current page inside the screenshot request guard", async () => {
    vi.useFakeTimers();
    try {
      const screenshot = vi.fn(async () => Buffer.from("PRIVATE"));
      const page = {
        url: vi.fn(() => "http://169.254.169.254/latest/meta-data/"),
        screenshot,
      };
      const blockedError = createBlockedNavigationError();
      navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(blockedError);
      setPwToolsCoreCurrentPage(page);

      const task = mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toBe(blockedError);

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(screenshot).not.toHaveBeenCalled();
      expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url: "http://169.254.169.254/latest/meta-data/",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["element", "ref"] as const)(
    "guards a safe %s screenshot through the full navigation window",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const navigation = createNavigationAwarePage();
        const screenshot = vi.fn(async () => Buffer.from("SAFE"));
        const page = {
          ...navigation.page,
          locator: vi.fn(() => ({ first: () => ({ screenshot }) })),
          screenshot: vi.fn(async () => Buffer.from("PAGE")),
        };
        setPwToolsCoreCurrentPage(page);
        setPwToolsCoreCurrentRefLocator({ screenshot });

        const task = mod.takeScreenshotViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ...(mode === "element" ? { element: "#main" } : { ref: "76" }),
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(screenshot).toHaveBeenCalledTimes(1);
        expect(navigation.listeners.size).toBe(1);
        expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
          expect.objectContaining({
            page,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
          }),
        );
        expect(
          sessionMocks.withPageNavigationRequestGuard.mock.invocationCallOrder[0],
        ).toBeLessThan(screenshot.mock.invocationCallOrder[0]);

        await vi.advanceTimersByTimeAsync(250);
        await expect(task).resolves.toMatchObject({ buffer: Buffer.from("SAFE") });
        expect(navigation.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(["element", "ref"] as const)(
    "rejects a blocked navigation triggered by a %s screenshot",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const navigation = createNavigationAwarePage();
        const screenshot = vi.fn(async () => {
          navigation.navigate("http://169.254.169.254/latest/meta-data");
          return Buffer.from("BLOCKED");
        });
        const page = {
          ...navigation.page,
          locator: vi.fn(() => ({ first: () => ({ screenshot }) })),
          screenshot: vi.fn(async () => Buffer.from("PAGE")),
        };
        const blockedError = createBlockedNavigationError();
        sessionMocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(blockedError);
        setPwToolsCoreCurrentPage(page);
        setPwToolsCoreCurrentRefLocator({ screenshot });

        const task = mod.takeScreenshotViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ...(mode === "element" ? { element: "#main" } : { ref: "76" }),
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        });
        const rejection = expect(task).rejects.toBe(blockedError);

        await vi.advanceTimersByTimeAsync(0);
        expect(screenshot).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        await rejection;
        expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith(
          expect.objectContaining({ url: "http://169.254.169.254/latest/meta-data" }),
        );
        expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
          expect.objectContaining({ page, targetId: "T1" }),
        );
        expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith(
          expect.objectContaining({ error: blockedError, page, targetId: "T1" }),
        );
        expect(navigation.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("rejects fullPage for element or ref screenshots", async () => {
    setPwToolsCoreCurrentRefLocator({ screenshot: vi.fn(async () => Buffer.from("R")) });
    setPwToolsCoreCurrentPage({
      locator: vi.fn(() => ({
        first: () => ({ screenshot: vi.fn(async () => Buffer.from("E")) }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    });

    await expect(
      mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        element: "#x",
        fullPage: true,
      }),
    ).rejects.toThrow(/fullPage is not supported/i);

    await expect(
      mod.takeScreenshotViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        fullPage: true,
      }),
    ).rejects.toThrow(/fullPage is not supported/i);
  });
  it("arms the next file chooser and sets files (default timeout)", async () => {
    const uploadPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-upload-${crypto.randomUUID()}.txt`);
    await fs.mkdir(path.dirname(uploadPath), { recursive: true });
    await fs.writeFile(uploadPath, "fixture", "utf8");
    const canonicalUploadPath = await fs.realpath(uploadPath);
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    const waitForEvent = vi.fn(async (_eventValue: string, _opts: unknown) => fileChooser);
    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    try {
      await mod.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        paths: [uploadPath],
      });

      // waitForEvent is awaited immediately; handler continues async.
      await Promise.resolve();

      expect(waitForEvent).toHaveBeenCalledWith("filechooser", {
        timeout: 120_000,
      });
      await vi.waitFor(() => {
        expect(fileChooser.setFiles).toHaveBeenCalledWith([canonicalUploadPath]);
      });
    } finally {
      await fs.rm(uploadPath, { force: true });
    }
  });
  it("revalidates file-chooser paths at use-time and cancels missing files", async () => {
    const missingPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-missing-${crypto.randomUUID()}.txt`);
    const { fileChooser, press } = createFileChooserPageMocks();

    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      paths: [missingPath],
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(press).toHaveBeenCalledWith("Escape");
    });
    expect(fileChooser.setFiles).not.toHaveBeenCalled();
  });
  it("arms the next file chooser and escapes if no paths provided", async () => {
    const { fileChooser, press } = createFileChooserPageMocks();

    await mod.armFileUploadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      paths: [],
    });
    await Promise.resolve();

    expect(fileChooser.setFiles).not.toHaveBeenCalled();
    expect(press).toHaveBeenCalledWith("Escape");
  });
});
