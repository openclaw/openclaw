import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "../paths.js";
import { chromiumTempDirs as tempDirs, withChromiumPage } from "./chromium.test-support.js";
import { registerBrowserRoutes } from "./index.js";

const withContentPage = (run: Parameters<typeof withChromiumPage>[1]) =>
  withChromiumPage(
    {
      "http://127.0.0.1:11111/content": "<main>Main text</main><article>Article text</article>",
    },
    run,
    registerBrowserRoutes,
  );

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
