import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "../paths.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
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

function selectField(element: Element) {
  (element as HTMLElement).focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.setSelectionRange(7, 10);
  } else {
    const text = element.firstChild!;
    window.getSelection()!.setBaseAndExtent(text, 7, text, 10);
  }
}

describe.runIf(process.env.OPENCLAW_BROWSER_PASTE_E2E === "1")("Chromium focused paste", () => {
  it("inserts at the selection in password, multiline, editable, and cross-origin fields", async () => {
    await withChromiumPage(
      {
        "http://127.0.0.1:11111/form": `<input id="password" type="password" value="before-old-after">
            <textarea id="multiline">before-old-after</textarea>
            <div id="editable" contenteditable>before-old-after</div>
            <iframe src="http://127.0.0.1:22222/field"></iframe>
            <script>document.addEventListener("input", () => document.body.dataset.input = "yes")</script>`,
        "http://127.0.0.1:22222/field":
          '<input id="frame" type="password" value="before-old-after">',
      },
      async ({ page, call, targetId }) => {
        const paste = async (text: string) => {
          const response = await call("post", "/act", { kind: "insertText", text });
          expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toMatchObject({ ok: true, targetId });
          expect(JSON.stringify(response.body)).not.toContain(text);
        };

        for (const [field, text] of [
          [page.locator("#password"), "  p🦞ss  "],
          [page.locator("#multiline"), "  first 🦞\nsecond  "],
          [page.locator("#editable"), "editable 🦞"],
          [page.frameLocator("iframe").locator("#frame"), "iframe 🦞"],
        ] as const) {
          await field.evaluate(selectField);
          await paste(text);
          const value = await field.evaluate((element) =>
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.value
              : element.textContent,
          );
          expect(value).toBe(`before-${text}-after`);
        }
        expect(await page.locator("body").getAttribute("data-input")).toBe("yes");
        expect(await page.locator("#password").inputValue()).toBe("before-  p🦞ss  -after");
      },
      registerBrowserAgentActRoutes,
    );
  }, 30_000);
});

describe.runIf(process.env.OPENCLAW_BROWSER_CONTENT_E2E === "1")(
  "Chromium browser content routes",
  () => {
    it.each(["", "  padded 🦞  "])(
      "preserves prompt response %j",
      (promptText) =>
        withContentPage(async ({ page, call }) => {
          const armed = await call("post", "/hooks/dialog", { accept: true, promptText });
          expect(armed.statusCode, JSON.stringify(armed.body)).toBe(200);
          expect(await page.evaluate(() => prompt("Enter a value", "default"))).toBe(promptText);
        }),
      30_000,
    );

    it.each(["local", "session"])(
      "returns every native %s storage key",
      (kind) =>
        withContentPage(async ({ page, call }) => {
          const entries: Array<[string, string]> = [
            ["", "empty"],
            ["__proto__", "prototype"],
            [" padded ", "spaces"],
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
          expect(selected.body).toHaveProperty("values.__proto__", "prototype");
        }),
      30_000,
    );

    it("honors the direct input upload deadline and leaves late inputs untouched", async () => {
      await withContentPage(async ({ page, call }) => {
        await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
        const file = path.join(tempDirs.make("content-upload-", DEFAULT_UPLOAD_DIR), "fixture.txt");
        await fs.writeFile(file, "synthetic upload");
        const upload = () =>
          call("post", "/hooks/file-chooser", {
            element: "#upload",
            paths: [file],
            timeoutMs: 500,
          });
        const uploadInput = page.locator("#upload");
        await call("get", "/text");
        await page.evaluate(() => {
          setTimeout(() => {
            document.body.insertAdjacentHTML("beforeend", '<input id="upload" type="file">');
          }, 1_500);
        });
        const response = await upload();
        expect(response.statusCode, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
        await uploadInput.waitFor({ state: "attached" });
        expect(await uploadInput.evaluate((el: HTMLInputElement) => el.files?.length)).toBe(0);
        const retry = await upload();
        expect(retry.statusCode, JSON.stringify(retry.body)).toBe(200);
        expect(await uploadInput.evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe(
          "fixture.txt",
        );
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
