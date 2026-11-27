import { expect, it } from "vitest";
import { withChromiumPage } from "./chromium.test-support.js";
import { registerBrowserRoutes } from "./index.js";

it.runIf(process.env.OPENCLAW_BROWSER_CRASH_E2E === "1")(
  "rejects a crashed tab before the snapshot deadline and marks it in the tab list",
  async () => {
    await withChromiumPage(
      { "http://127.0.0.1/victim": "<title>Victim</title>" },
      async ({ page, targetId, call }) => {
        const session = await page.context().newCDPSession(page);
        const crashed = page.waitForEvent("crash");
        void session.send("Page.crash").catch(() => {});
        await crashed;

        const snapshot = await call("get", "/snapshot", {}, {}, AbortSignal.timeout(5_000));
        expect(snapshot.statusCode).toBe(409);
        expect(snapshot.body).toMatchObject({
          error: expect.stringMatching(/tab crashed.*new tab/i),
        });
        const tabs = await call("get", "/tabs");
        expect(tabs.body).toMatchObject({
          tabs: expect.arrayContaining([expect.objectContaining({ targetId, crashed: true })]),
        });
      },
      registerBrowserRoutes,
    );
  },
  20_000,
);
