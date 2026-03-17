import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDiffRoot } from "./test-helpers.js";
const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn()
}));
vi.mock("playwright-core", () => ({
  chromium: {
    launch: launchMock
  }
}));
describe("PlaywrightDiffScreenshotter", () => {
  let rootDir;
  let outputPath;
  let cleanupRootDir;
  beforeEach(async () => {
    vi.useFakeTimers();
    ({ rootDir, cleanup: cleanupRootDir } = await createTempDiffRoot("openclaw-diffs-browser-"));
    outputPath = path.join(rootDir, "preview.png");
    launchMock.mockReset();
    const browserModule = await import("./browser.js");
    await browserModule.resetSharedBrowserStateForTests();
  });
  afterEach(async () => {
    const browserModule = await import("./browser.js");
    await browserModule.resetSharedBrowserStateForTests();
    vi.useRealTimers();
    await cleanupRootDir();
  });
  it("reuses the same browser across renders and closes it after the idle window", async () => {
    const { pages, browser, screenshotter } = await createScreenshotterHarness();
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8e6
      }
    });
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8e6
      }
    });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    expect(browser.newPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deviceScaleFactor: 2
      })
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.close).toHaveBeenCalledTimes(1);
    expect(pages[1]?.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1e3);
    expect(browser.close).toHaveBeenCalledTimes(1);
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "light",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8e6
      }
    });
    expect(launchMock).toHaveBeenCalledTimes(2);
  });
  it("renders PDF output when format is pdf", async () => {
    const { pages, browser, screenshotter } = await createScreenshotterHarness();
    const pdfPath = path.join(rootDir, "preview.pdf");
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath: pdfPath,
      theme: "light",
      image: {
        format: "pdf",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8e6
      }
    });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pdf).toHaveBeenCalledTimes(1);
    const pdfCall = pages[0]?.pdf.mock.calls[0]?.[0];
    expect(pdfCall).toBeDefined();
    expect(pdfCall).not.toHaveProperty("pageRanges");
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
    await expect(fs.readFile(pdfPath, "utf8")).resolves.toContain("%PDF-1.7");
  });
  it("fails fast when PDF render exceeds size limits", async () => {
    const pages = [];
    const browser = createMockBrowser(pages, {
      boundingBox: { x: 40, y: 40, width: 960, height: 6e4 }
    });
    launchMock.mockResolvedValue(browser);
    const { PlaywrightDiffScreenshotter } = await import("./browser.js");
    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1e3
    });
    const pdfPath = path.join(rootDir, "oversized.pdf");
    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath: pdfPath,
        theme: "light",
        image: {
          format: "pdf",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960,
          maxPixels: 8e6
        }
      })
    ).rejects.toThrow("Diff frame did not render within image size limits.");
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pdf).toHaveBeenCalledTimes(0);
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
  });
  it("fails fast when maxPixels is still exceeded at scale 1", async () => {
    const { pages, screenshotter } = await createScreenshotterHarness();
    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath,
        theme: "dark",
        image: {
          format: "png",
          qualityPreset: "standard",
          scale: 1,
          maxWidth: 960,
          maxPixels: 10
        }
      })
    ).rejects.toThrow("Diff frame did not render within image size limits.");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
  });
});
function createConfig() {
  return {
    browser: {
      executablePath: process.execPath
    }
  };
}
async function createScreenshotterHarness(options) {
  const pages = [];
  const browser = createMockBrowser(pages, options);
  launchMock.mockResolvedValue(browser);
  const { PlaywrightDiffScreenshotter } = await import("./browser.js");
  const screenshotter = new PlaywrightDiffScreenshotter({
    config: createConfig(),
    browserIdleMs: 1e3
  });
  return { pages, browser, screenshotter };
}
function createMockBrowser(pages, options) {
  const browser = {
    newPage: vi.fn(async () => {
      const page = createMockPage(options);
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {
    }),
    on: vi.fn()
  };
  return browser;
}
function createMockPage(options) {
  const box = options?.boundingBox ?? { x: 40, y: 40, width: 640, height: 240 };
  const screenshot = vi.fn(async ({ path: screenshotPath }) => {
    await fs.writeFile(screenshotPath, Buffer.from("png"));
  });
  const pdf = vi.fn(async ({ path: pdfPath }) => {
    await fs.writeFile(pdfPath, "%PDF-1.7 mock");
  });
  return {
    route: vi.fn(async () => {
    }),
    setContent: vi.fn(async () => {
    }),
    waitForFunction: vi.fn(async () => {
    }),
    evaluate: vi.fn(async () => 1),
    emulateMedia: vi.fn(async () => {
    }),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => {
      }),
      boundingBox: vi.fn(async () => box)
    })),
    setViewportSize: vi.fn(async () => {
    }),
    screenshot,
    pdf,
    close: vi.fn(async () => {
    })
  };
}
