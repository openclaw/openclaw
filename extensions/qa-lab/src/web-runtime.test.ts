import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bodyLocator: {
    waitFor: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "hello from body"),
  },
  browserClose: vi.fn(async () => undefined),
  contextClose: vi.fn(async () => undefined),
  existsSync: vi.fn((_candidate: unknown) => false),
  goto: vi.fn(async () => undefined),
  launch: vi.fn(),
  locatorFill: vi.fn(async () => undefined),
  locatorPress: vi.fn(async () => undefined),
  locatorWaitFor: vi.fn(async () => undefined),
  pageOn: vi.fn(),
  pageEvaluate: vi.fn(async () => "ok"),
  pageTitle: vi.fn(async () => "QA"),
  pageUrl: vi.fn(() => "http://127.0.0.1:3000/chat"),
  pageWaitForFunction: vi.fn(async () => undefined),
  pageWaitForSelector: vi.fn(async () => undefined),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.existsSync,
}));

vi.mock("playwright-core", () => ({
  chromium: { launch: mocks.launch },
}));

import {
  closeQaWebSessions,
  createQaWebPageOpener,
  qaWebEvaluate,
  qaWebSnapshot,
  qaWebType,
  qaWebWait,
} from "./web-runtime.js";

let openPage: ReturnType<typeof createQaWebPageOpener>;
const url = "http://127.0.0.1:3000/chat";

beforeEach(() => {
  openPage = createQaWebPageOpener(new Set());
  vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", undefined);
  const page = {
    on: mocks.pageOn,
    goto: mocks.goto,
    title: mocks.pageTitle,
    url: mocks.pageUrl,
    waitForSelector: mocks.pageWaitForSelector,
    waitForFunction: mocks.pageWaitForFunction,
    locator: vi.fn((selector: string) => {
      if (selector === "body") {
        return mocks.bodyLocator;
      }
      return {
        first: () => ({
          waitFor: mocks.locatorWaitFor,
          fill: mocks.locatorFill,
          press: mocks.locatorPress,
        }),
      };
    }),
    evaluate: mocks.pageEvaluate,
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: mocks.contextClose,
  };
  mocks.launch.mockResolvedValue({
    newContext: vi.fn(async () => context),
    close: mocks.browserClose,
  });
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(false);
  mocks.spawnSync.mockReturnValue({ status: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("qa web runtime", () => {
  it("opens, interacts with, snapshots, and closes a page", async () => {
    const opened = await openPage({ url });
    await qaWebWait({ pageId: opened.pageId, selector: "textarea" });
    await qaWebWait({ pageId: opened.pageId, text: "bridge armed" });
    await qaWebType({ pageId: opened.pageId, selector: "textarea", text: "hello", submit: true });
    const snapshot = await qaWebSnapshot({ pageId: opened.pageId, maxChars: 5 });
    const evaluated = await qaWebEvaluate({ pageId: opened.pageId, expression: "'ok'" });
    await closeQaWebSessions();

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["--import", "tsx", "scripts/ensure-playwright-chromium.mts", "--skip-ffmpeg"],
      expect.objectContaining({ cwd: process.cwd(), stdio: "inherit" }),
    );
    expect(mocks.launch).toHaveBeenCalledWith({ headless: true });
    expect(mocks.goto).toHaveBeenCalledWith(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(mocks.pageWaitForSelector).toHaveBeenCalledWith("textarea", { timeout: 20_000 });
    expect(mocks.pageWaitForFunction).toHaveBeenCalled();
    expect(mocks.locatorFill).toHaveBeenCalledWith("hello", { timeout: 20_000 });
    expect(mocks.locatorPress).toHaveBeenCalledWith("Enter", { timeout: 20_000 });
    expect(snapshot.text).toBe("hello");
    expect(evaluated).toBe("ok");
    expect(mocks.contextClose).toHaveBeenCalledTimes(1);
    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded web text on UTF-16 boundaries", async () => {
    mocks.bodyLocator.textContent.mockResolvedValueOnce(`${"a".repeat(1999)}😀tail`);
    const opened = await openPage({ url });
    const consoleHandler = mocks.pageOn.mock.calls.find(([event]) => event === "console")?.[1] as
      | ((message: { type: () => string; text: () => string }) => void)
      | undefined;
    if (!consoleHandler) {
      throw new Error("expected console handler");
    }
    consoleHandler({ type: () => "log", text: () => `${"a".repeat(1993)}😀tail` });
    const snapshot = await qaWebSnapshot({ pageId: opened.pageId, maxChars: 2000 });

    expect(snapshot.text).toBe("a".repeat(1999));
    expect(snapshot.diagnostics).toEqual([{ kind: "console", text: `[log] ${"a".repeat(1993)}` }]);
    await closeQaWebSessions();
  });

  it("launches an explicit Chromium executable override when configured", async () => {
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "/custom/chromium");
    mocks.existsSync.mockImplementation((candidate) => candidate === "/custom/chromium");
    await openPage({ url });
    expect(mocks.spawnSync).toHaveBeenCalledWith("/custom/chromium", ["--version"], {
      stdio: "ignore",
    });
    expect(mocks.launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: "/custom/chromium",
    });
    await closeQaWebSessions();
  });

  it("launches detected system Chromium without requiring branded Chrome", async () => {
    mocks.existsSync.mockImplementation((candidate) => candidate === "/usr/bin/chromium");
    await openPage({ url });
    expect(mocks.spawnSync).toHaveBeenCalledWith("/usr/bin/chromium", ["--version"], {
      stdio: "ignore",
    });
    expect(mocks.launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: "/usr/bin/chromium",
    });
    await closeQaWebSessions();
  });

  it("caps oversized web runtime timeouts", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const timeoutMs = Number.MAX_SAFE_INTEGER;
    const { pageId } = await openPage({ url, timeoutMs });
    await qaWebWait({ pageId, selector: "textarea", timeoutMs });
    await qaWebEvaluate({ pageId, expression: "'ok'", timeoutMs });
    await closeQaWebSessions();

    expect(mocks.goto).toHaveBeenCalledWith(url, {
      waitUntil: "domcontentloaded",
      timeout: MAX_TIMER_TIMEOUT_MS,
    });
    expect(mocks.pageWaitForSelector).toHaveBeenCalledWith("textarea", {
      timeout: MAX_TIMER_TIMEOUT_MS,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
