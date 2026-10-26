import { expectDefined } from "@openclaw/normalization-core";
import type { Page } from "playwright-core";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { launchChromium, readTargetId } from "../pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
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
  const { context, cdpUrl } = await launchChromium(
    chromiumTempDirs.make("openclaw-browser-routes-"),
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // The control connection owns dialog responses, not the fixture connection.
    page.on("dialog", () => {});
    for (const [url, body] of Object.entries(pages)) {
      await page.route(url, (route) => route.fulfill({ contentType: "text/html", body }));
    }
    await page.goto(expectDefined(Object.keys(pages)[0], "fixture page URL"));
    const targetId = await readTargetId(page);
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
      targetId,
      call: async (method, route, values, params, signal) => {
        const input = { targetId, ...values };
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
