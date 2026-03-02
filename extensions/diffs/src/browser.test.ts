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
    const pages: Array<{
      close: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
      pdf: ReturnType<typeof vi.fn>;
    }> = [];
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
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
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
        maxPixels: 8_000_000,
      },
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
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
    });

    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it("renders PDF output when format is pdf", async () => {
    const pages: Array<{
      close: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
      pdf: ReturnType<typeof vi.fn>;
    }> = [];
    const browser = createMockBrowser(pages);
    launchMock.mockResolvedValue(browser);
    const { PlaywrightDiffScreenshotter } = await import("./browser.js");

    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });
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
        maxPixels: 8_000_000,
      },
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pdf).toHaveBeenCalledTimes(1);
    const pdfCall = pages[0]?.pdf.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(pdfCall).toBeDefined();
    expect(pdfCall).not.toHaveProperty("pageRanges");
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
    await expect(fs.readFile(pdfPath, "utf8")).resolves.toContain("%PDF-1.7");
  });

  it("fails fast when PDF render exceeds size limits", async () => {
    const pages: Array<{
      close: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
      pdf: ReturnType<typeof vi.fn>;
    }> = [];
    const browser = createMockBrowser(pages, {
      boundingBox: { x: 40, y: 40, width: 960, height: 60_000 },
    });
    launchMock.mockResolvedValue(browser);
    const { PlaywrightDiffScreenshotter } = await import("./browser.js");

    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
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
          maxPixels: 8_000_000,
        },
      }),
    ).rejects.toThrow("Diff frame did not render within image size limits.");

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pdf).toHaveBeenCalledTimes(0);
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
  });

  it("fails fast when maxPixels is still exceeded at scale 1", async () => {
    const pages: Array<{
      close: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
      pdf: ReturnType<typeof vi.fn>;
    }> = [];
    const browser = createMockBrowser(pages);
    launchMock.mockResolvedValue(browser);
    const { PlaywrightDiffScreenshotter } = await import("./browser.js");

    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });

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
          maxPixels: 10,
        },
      }),
    ).rejects.toThrow("Diff frame did not render within image size limits.");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
  });
});

function createConfig(): OpenClawConfig {
  return {
    browser: {
      executablePath: process.execPath,
    },
  } as OpenClawConfig;
}

function createMockBrowser(
  pages: Array<{
    close: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    pdf: ReturnType<typeof vi.fn>;
  }>,
  options?: { boundingBox?: { x: number; y: number; width: number; height: number } },
) {
  const browser = {
    newPage: vi.fn(async () => {
      const page = createMockPage(options);
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {}),
    on: vi.fn(),
  };
  return browser;
}

function createMockPage(options?: {
  boundingBox?: { x: number; y: number; width: number; height: number };
}) {
  const box = options?.boundingBox ?? { x: 40, y: 40, width: 640, height: 240 };
  const screenshot = vi.fn(async ({ path: screenshotPath }: { path: string }) => {
    await fs.writeFile(screenshotPath, Buffer.from("png"));
  });
  const pdf = vi.fn(async ({ path: pdfPath }: { path: string }) => {
    await fs.writeFile(pdfPath, "%PDF-1.7 mock");
  });

  return {
    route: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 1),
    emulateMedia: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => {}),
      boundingBox: vi.fn(async () => box),
    })),
    setViewportSize: vi.fn(async () => {}),
    screenshot,
    pdf,
    close: vi.fn(async () => {}),
  };
}
