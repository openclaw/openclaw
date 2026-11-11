import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { launchChromium, readTargetId } from "./pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection, listPagesViaPlaywright } from "./pw-session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_COLD_CONNECT_E2E === "1")(
  "Chromium cold connection diagnostics",
  () => {
    it("names a pre-existing page whose renderer blocks Playwright initialization", async () => {
      const { context, cdpUrl } = await launchChromium(tempDirs.make("openclaw-cold-connect-"));
      try {
        const healthy = context.pages()[0] ?? (await context.newPage());
        await healthy.setContent("<title>healthy</title>");
        const wedged = await context.newPage();
        await wedged.setContent("<title>wedged</title>");
        const targetId = await readTargetId(wedged);
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
        await expect(listPagesViaPlaywright({ cdpUrl })).rejects.toThrow(targetId);
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
