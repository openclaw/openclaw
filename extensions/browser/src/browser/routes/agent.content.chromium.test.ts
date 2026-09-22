import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { DEFAULT_UPLOAD_DIR } from "../paths.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withContentPage(
  run: (fixture: {
    page: Page;
    call: (
      method: "get" | "post",
      route: string,
      values?: Record<string, unknown>,
      params?: Record<string, string>,
      signal?: AbortSignal,
    ) => Promise<ReturnType<typeof createBrowserRouteResponse>>;
  }) => Promise<void>,
) {
  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(tempDirs.make("openclaw-browser-content-"), "profile"),
    {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`],
    },
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // The control connection owns dialog responses; keep the fixture connection from dismissing them.
    page.on("dialog", () => {});
    await page.route("http://127.0.0.1:11111/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Main text</main><article>Article text</article>",
      }),
    );
    await page.goto("http://127.0.0.1:11111/content");
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const state: BrowserServerState = {
      port: 0,
      resolved: resolveBrowserConfig({
        defaultProfile: "content",
        evaluateEnabled: false,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        profiles: { content: { cdpUrl, color: "#123456", attachOnly: true } },
      }),
      profiles: new Map(),
    };
    const routes = createBrowserRouteApp();
    registerBrowserAgentRoutes(routes.app, createBrowserRouteContext({ getState: () => state }));
    await run({
      page,
      call: async (method, route, values, params, signal) => {
        const handler = expectDefined(
          (method === "get" ? routes.getHandlers : routes.postHandlers).get(route),
          `registered ${route} route`,
        );
        const response = createBrowserRouteResponse();
        const input = { targetId: targetInfo.targetId, ...values };
        await handler(
          {
            params: params ?? {},
            query: method === "get" ? input : {},
            body: method === "post" ? input : undefined,
            signal,
          },
          response.res,
        );
        return response;
      },
    });
  } finally {
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context.close();
  }
}

describe.runIf(process.env.OPENCLAW_BROWSER_CONTENT_E2E === "1")(
  "Chromium browser content routes",
  () => {
    it.each(["", "  padded 🦞  "])(
      "preserves prompt response %j",
      async (promptText) => {
        await withContentPage(async ({ page, call }) => {
          const armed = await call("post", "/hooks/dialog", { accept: true, promptText });
          expect(armed.statusCode, JSON.stringify(armed.body)).toBe(200);
          expect(await page.evaluate(() => prompt("Enter a value", "default"))).toBe(promptText);
        });
      },
      30_000,
    );

    it.each(["local", "session"])(
      "returns every native %s storage key",
      async (kind) => {
        await withContentPage(async ({ page, call }) => {
          const entries: Array<[string, string]> = [
            ["", "empty"],
            ["__proto__", "prototype"],
            [" padded ", "spaces"],
            ["normal", "value"],
          ];
          await page.evaluate(
            ({ kind: storageKind, entries: storageEntries }) => {
              const storage = storageKind === "local" ? localStorage : sessionStorage;
              for (const [key, value] of storageEntries) {
                storage.setItem(key, value);
              }
            },
            { kind, entries },
          );
          const response = await call("get", "/storage/:kind", {}, { kind });
          expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toMatchObject({ ok: true, values: Object.fromEntries(entries) });
          const selected = await call("get", "/storage/:kind", { key: "__proto__" }, { kind });
          expect(selected.body).toMatchObject({
            values: Object.fromEntries([["__proto__", "prototype"]]),
          });
        });
      },
      30_000,
    );

    it("honors the direct input upload deadline and leaves late inputs untouched", async () => {
      await withContentPage(async ({ page, call }) => {
        await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
        const file = path.join(tempDirs.make("content-upload-", DEFAULT_UPLOAD_DIR), "fixture.txt");
        await fs.writeFile(file, "synthetic upload");
        const warm = await call("get", "/text");
        expect(warm.body).toMatchObject({ ok: true, text: "Article text" });
        await page.evaluate(() => {
          setTimeout(() => {
            const input = document.createElement("input");
            input.type = "file";
            input.id = "upload";
            document.body.append(input);
          }, 1_500);
        });
        const response = await call("post", "/hooks/file-chooser", {
          element: "#upload",
          paths: [file],
          timeoutMs: 500,
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
        await page.locator("#upload").waitFor({ state: "attached" });
        expect(
          await page.locator("#upload").evaluate((input: HTMLInputElement) => input.files?.length),
        ).toBe(0);
        const retry = await call("post", "/hooks/file-chooser", {
          element: "#upload",
          paths: [file],
          timeoutMs: 500,
        });
        expect(retry.statusCode, JSON.stringify(retry.body)).toBe(200);
        expect(
          await page
            .locator("#upload")
            .evaluate((input: HTMLInputElement) => input.files?.[0]?.name),
        ).toBe("fixture.txt");
      });
    }, 30_000);

    it("cancels text inspection blocked by a dialog and reads again after dismissal", async () => {
      await withContentPage(async ({ page, call }) => {
        expect((await call("get", "/text")).body).toMatchObject({ text: "Article text" });
        const opened = page.waitForEvent("dialog");
        const prompt = page.evaluate(() => window.prompt("Synthetic blocker"));
        const dialog = await opened;
        try {
          const response = await call("get", "/text", {}, {}, AbortSignal.timeout(500));
          expect(response.statusCode, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
        } finally {
          await dialog.dismiss();
          await prompt;
        }
        expect((await call("get", "/text")).body).toMatchObject({ text: "Article text" });
      });
    }, 30_000);
  },
);
