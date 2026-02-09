/**
 * Browser tool — Playwright-based web automation.
 * Used for purchases, form filling, scraping, and any browser-based task.
 * Includes screenshot capture for approval flows.
 */

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;

/**
 * Get or launch the managed browser instance.
 * Uses persistent context to maintain cookies/sessions across tasks.
 */
export async function getBrowser(opts?: {
  userDataDir?: string;
  headless?: boolean;
}): Promise<BrowserContext> {
  if (contextInstance) {
    return contextInstance;
  }

  const userDataDir =
    opts?.userDataDir ?? path.join(process.env.HOME ?? "/tmp", ".llm-router-browser");

  await fs.mkdir(userDataDir, { recursive: true });

  contextInstance = await chromium.launchPersistentContext(userDataDir, {
    headless: opts?.headless ?? true,
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "en-GB",
    timezoneId: "Europe/London",
  });

  return contextInstance;
}

/**
 * Navigate to a URL.
 */
export async function navigate(
  page: Page,
  url: string,
  opts?: { waitFor?: "load" | "domcontentloaded" | "networkidle" },
): Promise<void> {
  await page.goto(url, {
    waitUntil: opts?.waitFor ?? "domcontentloaded",
    timeout: 30_000,
  });
}

/**
 * Take a screenshot and save it.
 * Returns the file path of the saved screenshot.
 */
export async function screenshot(
  page: Page,
  savePath: string,
  opts?: { fullPage?: boolean },
): Promise<string> {
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await page.screenshot({
    path: savePath,
    fullPage: opts?.fullPage ?? false,
  });
  return savePath;
}

/**
 * Click an element by selector or visible text.
 */
export async function click(
  page: Page,
  target: string,
  opts?: { timeout?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 10_000;

  // Try as selector first
  try {
    await page.click(target, { timeout });
    return;
  } catch {
    // Fall through to text-based click
  }

  // Try clicking by visible text
  await page.getByText(target, { exact: false }).first().click({ timeout });
}

/**
 * Type text into an input field.
 */
export async function type(
  page: Page,
  selector: string,
  text: string,
  opts?: { delay?: number; clear?: boolean },
): Promise<void> {
  if (opts?.clear) {
    await page.fill(selector, "");
  }
  await page.fill(selector, text);
}

/**
 * Extract text content from the page.
 */
export async function extractText(page: Page, selector?: string): Promise<string> {
  if (selector) {
    const element = await page.$(selector);
    return (await element?.textContent()) ?? "";
  }
  return page.innerText("body");
}

/**
 * Extract structured data from a page using a CSS selector pattern.
 */
export async function extractAll(
  page: Page,
  selector: string,
  fields: Record<string, string>,
): Promise<Record<string, string>[]> {
  return page.$$eval(
    selector,
    (elements, fieldMap) => {
      return elements.map((el) => {
        const result: Record<string, string> = {};
        for (const [key, sel] of Object.entries(fieldMap)) {
          const child = el.querySelector(sel as string);
          result[key] = child?.textContent?.trim() ?? "";
        }
        return result;
      });
    },
    fields,
  );
}

/**
 * Wait for a specific condition.
 */
export async function waitFor(
  page: Page,
  selectorOrText: string,
  opts?: { timeout?: number; state?: "visible" | "attached" | "hidden" },
): Promise<void> {
  const timeout = opts?.timeout ?? 15_000;

  try {
    await page.waitForSelector(selectorOrText, {
      timeout,
      state: opts?.state ?? "visible",
    });
  } catch {
    // Try waiting for text
    await page.getByText(selectorOrText, { exact: false })
      .first()
      .waitFor({ timeout, state: opts?.state ?? "visible" });
  }
}

/**
 * Get a new page in the managed browser context.
 */
export async function newPage(): Promise<Page> {
  const context = await getBrowser();
  return context.newPage();
}

/**
 * Close the managed browser.
 */
export async function closeBrowser(): Promise<void> {
  if (contextInstance) {
    await contextInstance.close();
    contextInstance = null;
  }
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
