import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(Boolean(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH))(
  "Chromium browser storage keys",
  () => {
    it("reads and writes padded keys without changing the unpadded key", async () => {
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-browser-storage-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.route("http://127.0.0.1:11111/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<title>Storage fixture</title>" }),
        );
        await page.goto("http://127.0.0.1:11111/storage");
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: "storage",
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: { storage: { cdpUrl, color: "#123456", attachOnly: true } },
          }),
          profiles: new Map(),
        };
        const routes = createBrowserRouteApp();
        registerBrowserAgentStorageRoutes(
          routes.app,
          createBrowserRouteContext({ getState: () => state }),
        );
        const get = expectDefined(routes.getHandlers.get("/storage/:kind"), "storage get route");
        const set = expectDefined(
          routes.postHandlers.get("/storage/:kind/set"),
          "storage set route",
        );
        for (const kind of ["local", "session"] as const) {
          await page.evaluate((storageKind) => {
            const store = storageKind === "local" ? localStorage : sessionStorage;
            store.setItem("account", "original");
            store.setItem(" account ", "padded");
          }, kind);
          const read = createBrowserRouteResponse();
          await get(
            { params: { kind }, query: { targetId: targetInfo.targetId, key: " account " } },
            read.res,
          );
          expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
          expect.soft(read.body).toMatchObject({ values: { " account ": "padded" } });
          const write = createBrowserRouteResponse();
          await set(
            {
              params: { kind },
              query: {},
              body: { targetId: targetInfo.targetId, key: " account ", value: "updated" },
            },
            write.res,
          );
          expect(write.statusCode, JSON.stringify(write.body)).toBe(200);
          const values = await page.evaluate((storageKind) => {
            const store = storageKind === "local" ? localStorage : sessionStorage;
            return { plain: store.getItem("account"), padded: store.getItem(" account ") };
          }, kind);
          console.log(JSON.stringify({ kind, read: read.body, values }));
          expect.soft(values).toEqual({ plain: "original", padded: "updated" });
        }
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);
  },
);
