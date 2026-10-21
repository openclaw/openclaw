import { describe, expect, it } from "vitest";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { withChromiumPage } from "./chromium.test-support.js";

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

        for (const [selector, text] of [
          ["#password", "  p🦞ss  "],
          ["#multiline", "  first 🦞\nsecond  "],
        ] as const) {
          const field = page.locator(selector);
          await field.evaluate((element) => {
            const input = element as HTMLInputElement;
            input.focus();
            input.setSelectionRange(7, 10);
          });
          await paste(text);
          expect(await field.inputValue()).toBe(`before-${text}-after`);
        }
        expect(await page.locator("body").getAttribute("data-input")).toBe("yes");

        const editable = page.locator("#editable");
        await editable.evaluate((element) => {
          (element as HTMLElement).focus();
          const range = document.createRange();
          range.setStart(element.firstChild!, 7);
          range.setEnd(element.firstChild!, 10);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await paste("editable 🦞");
        expect(await editable.textContent()).toBe("before-editable 🦞-after");

        const frameField = page.frameLocator("iframe").locator("#frame");
        await frameField.evaluate((element) => {
          const input = element as HTMLInputElement;
          input.focus();
          input.setSelectionRange(7, 10);
        });
        await paste("iframe 🦞");
        expect(await frameField.inputValue()).toBe("before-iframe 🦞-after");
        expect(await page.locator("#password").inputValue()).toBe("before-  p🦞ss  -after");
      },
      registerBrowserAgentActRoutes,
    );
  }, 30_000);
});
