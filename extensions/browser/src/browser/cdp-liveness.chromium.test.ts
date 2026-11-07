import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { assertCdpTargetResponsive } from "./cdp.js";
import { launchChromium, readTargetId } from "./pw-chromium.test-support.js";
import { BrowserTargetCrashedError } from "./target-crash.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_CRASH_E2E === "1")("crashed target liveness", () => {
  it("fails fast on a real crashed renderer", async () => {
    const { context, cdpUrl } = await launchChromium(tempDirs.make("openclaw-crash-probe-"));
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setContent("<title>crash-probe</title>");
      const targetId = await readTargetId(page);
      const targets = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{
        id?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const pageWsUrl = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl;
      if (!pageWsUrl) {
        throw new Error("Crashed target is missing its page-level CDP endpoint");
      }

      const session = await context.newCDPSession(page);
      const crashed = new Promise<void>((resolve) => {
        page.once("crash", () => resolve());
      });
      session.send("Page.crash").catch(() => {});
      await crashed;

      const startedAt = Date.now();
      await expect(
        assertCdpTargetResponsive({ wsUrl: pageWsUrl, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({
        name: "BrowserTargetCrashedError",
        message: new BrowserTargetCrashedError().message,
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await context
        .browser()
        ?.close()
        .catch(() => {});
    }
  }, 20_000);
});
