import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { closePlaywrightBrowserConnection, listPagesViaPlaywright } from "./pw-session.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_COLD_CONNECT_E2E === "1")(
  "Chromium cold connection diagnostics",
  () => {
    it("names a pre-existing page whose renderer blocks Playwright initialization", async () => {
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-cold-connect-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const healthy = context.pages()[0] ?? (await context.newPage());
        await healthy.setContent("<title>healthy</title>");
        const wedged = await context.newPage();
        await wedged.setContent("<title>wedged</title>");
        const session = await context.newCDPSession(wedged);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        await wedged.evaluate(() => {
          setTimeout(() => {
            for (;;) {
              // Deliberately block this renderer after evaluate returns.
            }
          }, 100);
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });

        const startedAt = Date.now();
        await expect(listPagesViaPlaywright({ cdpUrl })).rejects.toThrow(targetInfo.targetId);
        expect(Date.now() - startedAt).toBeLessThan(10_000);
        await expect(healthy.title()).resolves.toBe("healthy");
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl }).catch(() => {});
        await context
          .browser()
          ?.close()
          .catch(() => {});
      }
    }, 20_000);
  },
);
