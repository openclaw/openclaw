import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const body = {
    waitFor: async () => undefined,
    textContent: vi.fn(async () => "hello from body"),
  };
  const input = {
    waitFor: async () => undefined,
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
  };
  const page = {
    goto: vi.fn(async () => undefined),
    on: vi.fn(),
    evaluate: async () => "ok",
    title: async () => "QA",
    url: () => "http://127.0.0.1:3000/chat",
    waitForFunction: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => undefined),
    locator: (selector: string) => (selector === "body" ? body : { first: () => input }),
  };
  const context = { newPage: async () => page, close: async () => undefined };
  return {
    body,
    input,
    page,
    existsSync: vi.fn((_candidate: unknown) => false),
    spawnSync: vi.fn(() => ({ status: 0 })),
    launch: vi.fn(async () => ({ newContext: async () => context, close: async () => undefined })),
  };
});

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
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(false);
});

afterEach(async () => {
  await closeQaWebSessions();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("interacts with a page and bounds its text on UTF-16 boundaries", async () => {
  mocks.body.textContent.mockResolvedValueOnce(`${"a".repeat(1999)}😀tail`);
  const { pageId } = await openPage({ url });
  await qaWebWait({ pageId, selector: "textarea" });
  await qaWebWait({ pageId, text: "bridge armed" });
  await qaWebType({ pageId, selector: "textarea", text: "hello", submit: true });
  expect(mocks.page.waitForSelector).toHaveBeenCalledWith("textarea", { timeout: 20_000 });
  expect(mocks.page.waitForFunction).toHaveBeenCalled();
  expect(mocks.input.fill).toHaveBeenCalledWith("hello", { timeout: 20_000 });
  expect(mocks.input.press).toHaveBeenCalledWith("Enter", { timeout: 20_000 });
  const consoleHandler = mocks.page.on.mock.calls.find(([event]) => event === "console")?.[1] as
    | ((message: { type: () => string; text: () => string }) => void)
    | undefined;
  if (!consoleHandler) {
    throw new Error("expected console handler");
  }
  consoleHandler({ type: () => "log", text: () => `${"a".repeat(1993)}😀tail` });
  const snapshot = await qaWebSnapshot({ pageId, maxChars: 2000 });

  expect(snapshot.text).toBe("a".repeat(1999));
  expect(snapshot.diagnostics).toEqual([{ kind: "console", text: `[log] ${"a".repeat(1993)}` }]);
});

it.each([
  ["explicit override", "/custom/chromium"],
  ["detected system Chromium", "/usr/bin/chromium"],
])("launches %s without requiring branded Chrome", async (mode, executablePath) => {
  if (mode === "explicit override") {
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", executablePath);
  }
  mocks.existsSync.mockImplementation((candidate) => candidate === executablePath);
  await openPage({ url });
  expect(mocks.launch).toHaveBeenCalledWith({ headless: true, executablePath });
});

it("caps oversized web runtime timeouts", async () => {
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  const timeoutMs = Number.MAX_SAFE_INTEGER;
  const { pageId } = await openPage({ url, timeoutMs });
  await qaWebWait({ pageId, selector: "textarea", timeoutMs });
  await expect(qaWebEvaluate({ pageId, expression: "'ok'", timeoutMs })).resolves.toBe("ok");

  expect(mocks.page.goto).toHaveBeenCalledWith(url, {
    waitUntil: "domcontentloaded",
    timeout: MAX_TIMER_TIMEOUT_MS,
  });
  expect(mocks.page.waitForSelector).toHaveBeenCalledWith("textarea", {
    timeout: MAX_TIMER_TIMEOUT_MS,
  });
  expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  expect(clearTimeoutSpy).toHaveBeenCalled();
});
