import { afterEach, expect, it as test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { resolveBrowserConfig } from "./config.js";
import { readTargetId, withChromiumPage } from "./pw-chromium.test-support.js";
import { registerBrowserAgentStorageRoutes } from "./routes/agent.storage.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const it = test.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1");
it("exports only ordinary cookies through the route in the selected non-default context", async () => {
  await withChromiumPage(
    tempDirs.make("openclaw-cookie-partition-"),
    "<p>cookie qualification</p>",
    async ({ context, target }) => {
      const cookie = {
        name: "session",
        value: "ordinary",
        domain: ".example.test",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: true,
        sameSite: "None" as const,
      };
      await context.addCookies([{ ...cookie, value: "wrong-context" }]);
      const isolated = await context.browser()!.newContext();
      try {
        const page = await isolated.newPage();
        const targetId = await readTargetId(page);
        await isolated.addCookies([
          cookie,
          { ...cookie, value: "partitioned", partitionKey: "https://top.test" },
        ]);
        expect(await isolated.cookies()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "session",
              value: "partitioned",
              partitionKey: "https://top.test",
            }),
          ]),
        );
        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: "capture",
            profiles: { capture: { cdpUrl: target.cdpUrl, color: "#123456", attachOnly: true } },
          }),
          profiles: new Map(),
        };
        const routes = createBrowserRouteApp();
        registerBrowserAgentStorageRoutes(
          routes.app,
          createBrowserRouteContext({ getState: () => state }),
        );
        const capture = async (partition?: string) => {
          const response = createBrowserRouteResponse();
          await routes.getHandlers.get("/cookies")!(
            { params: {}, query: { targetId, ...(partition ? { partition } : {}) } },
            response.res,
          );
          expect(response.statusCode).toBe(200);
          return response.body;
        };
        expect(await capture("unpartitioned")).toMatchObject({
          ok: true,
          targetId,
          cookiePartition: "unpartitioned",
          cookies: [cookie],
        });
      } finally {
        await isolated.close();
      }
    },
  );
});
