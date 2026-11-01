import path from "node:path";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { getFreePort } from "./test-port.js";

export type ChromiumTarget = { cdpUrl: string; targetId: string };

export async function readTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    return (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

export async function launchChromium(
  rootDir: string,
  options: Pick<BrowserContextOptions, "viewport" | "deviceScaleFactor"> & {
    ignoreDefaultArgs?: string[];
  } = {},
) {
  const port = await getFreePort();
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(rootDir, "profile"),
    {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`],
      ...options,
    },
  );
  return { context, cdpUrl: `http://127.0.0.1:${port}` };
}

export async function withChromiumPage(
  rootDir: string,
  html: string,
  run: (fixture: { page: Page; context: BrowserContext; target: ChromiumTarget }) => Promise<void>,
  options?: Parameters<typeof launchChromium>[1],
) {
  const { context, cdpUrl } = await launchChromium(rootDir, options);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setContent(html);
    await run({ page, context, target: { cdpUrl, targetId: await readTargetId(page) } });
  } finally {
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context.close();
  }
}
