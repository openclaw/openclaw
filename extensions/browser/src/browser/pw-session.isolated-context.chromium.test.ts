import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import * as session from "./pw-session.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readStorage = () => ({ cookie: document.cookie, identity: localStorage.getItem("identity") });

it.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "isolates profile/sibling credentials and owns popup cleanup",
  async () => {
    const receivedCookies: string[] = [];
    await using server = createServer((request, response) => {
      if (request.url?.startsWith("/session-context/")) {
        receivedCookies.push(request.headers.cookie ?? "");
      }
      response.setHeader("Content-Type", "text/html").end("<!doctype html>");
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const port = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const admin = await getPlaywrightCore().chromium.launchPersistentContext(
      tempDirs.make("openclaw-isolated-context-"),
      { headless: true, executablePath, args: [`--remote-debugging-port=${port}`] },
    );
    const owned: Array<Awaited<ReturnType<typeof session.createPageViaPlaywright>>> = [];
    async function create(index: number) {
      const handle = await session.createPageViaPlaywright({
        cdpUrl,
        url: `${url}session-context/${index}`,
        isolatedContext: true,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      owned.push(handle);
      const page = await session.getPageForTargetId({ cdpUrl, targetId: handle.targetId });
      return { handle, page };
    }
    try {
      const adminPage = admin.pages()[0] ?? (await admin.newPage());
      await admin.addCookies([{ name: "admin_session", value: "private", url }]);
      await adminPage.goto(url);
      await adminPage.evaluate(() => localStorage.setItem("identity", "admin"));
      const { handle: firstOwned, page: first } = await create(0);
      const { page: second } = await create(1);
      expect(first.context()).not.toBe(second.context());
      expect(receivedCookies).toEqual(["", ""]);
      expect(await first.context().cookies(url)).toEqual([]);
      expect(await second.context().cookies(url)).toEqual([]);
      expect(await first.evaluate(readStorage)).toEqual({ cookie: "", identity: null });
      await first.evaluate(() => {
        document.cookie = "session_only=one";
        localStorage.setItem("identity", "one");
      });
      expect(await second.evaluate(readStorage)).toEqual({ cookie: "", identity: null });
      expect(await adminPage.evaluate(() => localStorage.getItem("identity"))).toBe("admin");
      const popupPromise = first.waitForEvent("popup");
      await first.evaluate((target) => void window.open(target), url);
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(popup.context()).toBe(first.context());
      await firstOwned.close();
      expect([first, popup].map((page) => page.isClosed())).toEqual([true, true]);
      expect(owned.map((page) => page.isCurrent())).toEqual([false, true]);
      expect(adminPage.isClosed()).toBe(false);
    } finally {
      await Promise.allSettled(owned.map((page) => page.close()));
      await session.closePlaywrightBrowserConnection({ cdpUrl });
      await admin.close();
    }
  },
  60_000,
);
