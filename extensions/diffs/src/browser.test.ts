import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: launchMock,
  },
}));

describe("PlaywrightDiffScreenshotter", () => {
  let rootDir: string;
  let outputPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-diffs-browser-"));
    outputPath = path.join(rootDir, "preview.png");
    launchMock.mockReset();
    const browserModule = await import("./browser.js");
    await browserModule.resetSharedBrowserStateForTests();
  });

  afterEach(async () => {
    const browserModule = await import("./browser.js");
    await browserModule.resetSharedBrowserStateForTests();
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reuses the same browser across renders and closes it after the idle window", async () => {
    const pages: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const browser = createMockBrowser(pages);
    launchMock.mockResolvedValue(browser);
    const { PlaywrightDiffScreenshotter } = await import("./browser.js");

    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });

    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
    });
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    expect(browser.newPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deviceScaleFactor: 2,
      }),
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.close).toHaveBeenCalledTimes(1);
    expect(pages[1]?.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "light",
    });

    expect(launchMock).toHaveBeenCalledTimes(2);
  });
});

function createConfig(): OpenClawConfig {
  return {
    browser: {
      executablePath: process.execPath,
    },
  } as OpenClawConfig;
}

function createMockBrowser(pages: Array<{ close: ReturnType<typeof vi.fn> }>) {
  const browser = {
    newPage: vi.fn(async () => {
      const page = createMockPage();
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {}),
    on: vi.fn(),
  };
  return browser;
}

function createMockPage() {
  return {
    route: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => {}),
      boundingBox: vi.fn(async () => ({ x: 40, y: 40, width: 640, height: 240 })),
    })),
    setViewportSize: vi.fn(async () => {}),
    screenshot: vi.fn(async ({ path: screenshotPath }: { path: string }) => {
      await fs.writeFile(screenshotPath, Buffer.from("png"));
    }),
    close: vi.fn(async () => {}),
  };
}
