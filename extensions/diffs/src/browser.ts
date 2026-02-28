import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { chromium } from "playwright-core";
import type { DiffTheme } from "./types.js";
import { VIEWER_ASSET_PREFIX, getServedViewerAsset } from "./viewer-assets.js";

export type DiffScreenshotter = {
  screenshotHtml(params: { html: string; outputPath: string; theme: DiffTheme }): Promise<string>;
};

export class PlaywrightDiffScreenshotter implements DiffScreenshotter {
  private readonly config: OpenClawConfig;

  constructor(params: { config: OpenClawConfig }) {
    this.config = params.config;
  }

  async screenshotHtml(params: {
    html: string;
    outputPath: string;
    theme: DiffTheme;
  }): Promise<string> {
    await fs.mkdir(path.dirname(params.outputPath), { recursive: true });
    const executablePath = await resolveBrowserExecutablePath(this.config);
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    try {
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ["--disable-dev-shm-usage", "--disable-gpu"],
      });

      const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
        colorScheme: params.theme,
      });
      await page.route(`http://127.0.0.1${VIEWER_ASSET_PREFIX}*`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const asset = await getServedViewerAsset(pathname);
        if (!asset) {
          await route.abort();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: asset.contentType,
          body: asset.body,
        });
      });
      await page.setContent(injectBaseHref(params.html), { waitUntil: "load" });
      await page.waitForFunction(
        () => {
          if (document.documentElement.dataset.openclawDiffsReady === "true") {
            return true;
          }
          return [...document.querySelectorAll("[data-openclaw-diff-host]")].every((element) => {
            return (
              element instanceof HTMLElement && element.shadowRoot?.querySelector("[data-diffs]")
            );
          });
        },
        {
          timeout: 10_000,
        },
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.evaluate(() => {
        const frame = document.querySelector(".oc-frame");
        if (frame instanceof HTMLElement) {
          frame.dataset.renderMode = "image";
        }
      });

      const frame = page.locator(".oc-frame");
      await frame.waitFor();
      const initialBox = await frame.boundingBox();
      if (!initialBox) {
        throw new Error("Diff frame did not render.");
      }

      const padding = 20;
      const clipWidth = Math.ceil(initialBox.width + padding * 2);
      const clipHeight = Math.ceil(Math.max(initialBox.height + padding * 2, 320));
      await page.setViewportSize({
        width: Math.max(clipWidth + padding, 900),
        height: Math.max(clipHeight + padding, 700),
      });

      const box = await frame.boundingBox();
      if (!box) {
        throw new Error("Diff frame was lost after resizing.");
      }

      await page.screenshot({
        path: params.outputPath,
        type: "png",
        clip: {
          x: Math.max(box.x - padding, 0),
          y: Math.max(box.y - padding, 0),
          width: clipWidth,
          height: clipHeight,
        },
      });
      return params.outputPath;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Diff image rendering requires a Chromium-compatible browser. Set browser.executablePath or install Chrome/Chromium. ${reason}`,
      );
    } finally {
      await browser?.close().catch(() => {});
    }
  }
}

function injectBaseHref(html: string): string {
  if (html.includes("<base ")) {
    return html;
  }
  return html.replace("<head>", '<head><base href="http://127.0.0.1/" />');
}

async function resolveBrowserExecutablePath(config: OpenClawConfig): Promise<string | undefined> {
  const configPath = config.browser?.executablePath?.trim();
  if (configPath) {
    await assertExecutable(configPath, "browser.executablePath");
    return configPath;
  }

  const envCandidates = [
    process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH,
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of envCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const candidate of await collectExecutableCandidates()) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function collectExecutableCandidates(): Promise<string[]> {
  const candidates = new Set<string>();

  for (const command of pathCommandsForPlatform()) {
    const resolved = await findExecutableInPath(command);
    if (resolved) {
      candidates.add(resolved);
    }
  }

  for (const candidate of commonExecutablePathsForPlatform()) {
    candidates.add(candidate);
  }

  return [...candidates];
}

function pathCommandsForPlatform(): string[] {
  if (process.platform === "win32") {
    return ["chrome.exe", "msedge.exe", "brave.exe"];
  }
  if (process.platform === "darwin") {
    return ["google-chrome", "chromium", "msedge", "brave-browser", "brave"];
  }
  return [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "msedge",
    "brave-browser",
    "brave",
  ];
}

function commonExecutablePathsForPlatform(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ];
  }

  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/msedge",
    "/usr/bin/brave-browser",
    "/snap/bin/chromium",
  ];
}

async function findExecutableInPath(command: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function assertExecutable(candidate: string, label: string): Promise<void> {
  if (!(await isExecutable(candidate))) {
    throw new Error(`${label} not found or not executable: ${candidate}`);
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
