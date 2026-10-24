import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Page } from "playwright-core";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import { createRouteFixture } from "./request.test-support.js";

export const chromiumTempDirs = useAutoCleanupTempDirTracker(afterEach);
type RouteCall = (
  method: "get" | "post",
  route: string,
  values?: Record<string, unknown>,
  params?: Record<string, string>,
  signal?: AbortSignal,
) => ReturnType<ReturnType<typeof createRouteFixture>["request"]>;

export async function withChromiumPage(
  pages: Record<string, string>,
  run: (fixture: { page: Page; call: RouteCall; targetId: string }) => Promise<void>,
  register: (
    app: ReturnType<typeof createRouteFixture>["app"],
    ctx: ReturnType<typeof createBrowserRouteContext>,
  ) => void,
) {
  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(chromiumTempDirs.make("openclaw-browser-routes-"), "profile"),
    {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`],
    },
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // The control connection owns dialog responses, not the fixture connection.
    page.on("dialog", () => {});
    for (const [url, body] of Object.entries(pages)) {
      await page.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
    }
    await page.goto(expectDefined(Object.keys(pages)[0], "fixture page URL"));
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const state: BrowserServerState = {
      port: 0,
      resolved: resolveBrowserConfig({
        defaultProfile: "fixture",
        evaluateEnabled: false,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        profiles: { fixture: { cdpUrl, color: "#123456", attachOnly: true } },
      }),
      profiles: new Map(),
    };
    const routes = createRouteFixture();
    register(routes.app, createBrowserRouteContext({ getState: () => state }));
    await run({
      page,
      targetId: targetInfo.targetId,
      call: async (method, route, values, params, signal) => {
        const input = { targetId: targetInfo.targetId, ...values };
        return routes.request(method, route, {
          params: params ?? {},
          query: method === "get" ? input : {},
          body: method === "post" ? input : undefined,
          signal,
        });
      },
    });
  } finally {
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context.close();
  }
}
