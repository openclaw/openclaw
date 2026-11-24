import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { launchChromium, readTargetId } from "./pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import {
  type BrowserOperatorInput,
  sendOperatorInputViaPlaywright,
} from "./pw-tools-core.interactions.operator.js";

const runChromiumProof = process.env.OPENCLAW_BROWSER_OPERATOR_INPUT_E2E === "1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const recordKeys = `<script>window.keys=[];addEventListener("keydown",(e)=>keys.push(e.key),true)</script>`;
const pages: Record<string, string> = {
  "/a": `${recordKeys}<form action="/b"><input id="q" name="q" autofocus></form>
    <a id="blocked" href="http://localhost:PORT/c" style="display:block;width:200px;height:40px">blocked</a>
    <script>addEventListener("keydown",(e)=>{if(e.key==="n")setTimeout(()=>{location.href=document.getElementById("blocked").href},200)})</script>`,
  "/b": `${recordKeys}<input id="r" autofocus>`,
  "/c": `<p>blocked target</p>`,
  "/f": `${recordKeys}<input id="q" autofocus><iframe id="embed" src="/frame"></iframe>
    <script>addEventListener("keydown",(e)=>{const embed=document.getElementById("embed");
    if(e.key==="r")embed.src="/frame?reload="+Date.now();
    if(e.key==="d")embed.src="http://localhost:PORT/frame";})</script>`,
  "/frame": `<p>embedded frame</p>`,
};

const keys = (text: string): BrowserOperatorInput[] =>
  Array.from(text, (key) => ({ kind: "press", key }));

describe.runIf(runChromiumProof)("operator input in Chromium", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).toReversed()) {
      await dispose();
    }
  });

  async function openFormPage(start = "/a") {
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      res.writeHead(200, { "content-type": "text/html" });
      res.end((pages[path] ?? "").replace("PORT", String(port)));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    cleanup.push(
      () =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    );
    const { context, cdpUrl } = await launchChromium(tempDirs.make("openclaw-operator-input-"));
    cleanup.push(async () => await context.close());
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl }));
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`http://127.0.0.1:${port}${start}`);
    const targetId = await readTargetId(page);
    const send = (inputs: BrowserOperatorInput[]) =>
      sendOperatorInputViaPlaywright({
        cdpUrl,
        targetId,
        // Allow this loopback fixture while keeping every other private host blocked.
        ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
        inputs,
      });
    return { page, send };
  }

  it("withholds keys that follow a navigation from the new document", async () => {
    const { page, send } = await openFormPage();
    // How many keys after Enter reach the old document depends on when the request
    // event arrives; the invariant is that the new document never gets this burst's keys.
    expect(
      await send(keys("abc").concat({ kind: "press", key: "Enter" }, ...keys("def"))),
    ).toMatchObject({ navigated: true });
    await page.waitForURL(/\/b\?q=abc$/);
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    expect(await page.locator("#r").inputValue()).toBe("");

    // The next burst opens a fresh session on the checked document.
    expect(await send(keys("xy"))).toMatchObject({ sent: 2 });
    expect(await page.locator("#r").inputValue()).toBe("xy");
  });

  it("keeps typing through an allowed iframe reload", async () => {
    const { page, send } = await openFormPage("/f");
    // No "d" or "r": those keys start the page's other iframe navigations.
    const typed = "abcefghijk".repeat(4);
    const result = await send(keys(`r${typed}`));
    expect(result.sent).toBe(typed.length + 1);
    expect(result.navigated).toBeUndefined();
    expect(await page.locator("#q").inputValue()).toBe(`r${typed}`);
    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes("reload=")))
      .toBe(true);
  });

  it("stops input when an iframe navigates to a blocked address", async () => {
    const { send } = await openFormPage("/f");
    // The burst whose key started the iframe navigation reports the denial itself.
    await expect(send(keys("dz"))).rejects.toThrow(/blocked|private|not allowed/i);
  });

  it("keeps policy denial for navigation started inside a session", async () => {
    const { page, send } = await openFormPage();
    const box = (await page.locator("#blocked").boundingBox())!;
    await expect(
      send([{ kind: "clickCoords", x: box.x + 10, y: box.y + 10 }, ...keys("zz")]),
    ).rejects.toThrow(/blocked|private|not allowed/i);
    expect(new URL(page.url()).pathname).toBe("/a");
  });
});
