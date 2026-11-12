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
};

const keys = (text: string): BrowserOperatorInput[] =>
  Array.from(text, (key) => ({ kind: "press", key }));

describe.runIf(runChromiumProof)("operator input sessions in Chromium", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).toReversed()) {
      await dispose();
    }
  });

  async function openFormPage() {
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
    await page.goto(`http://127.0.0.1:${port}/a`);
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
    // Which burst reports a navigation is best effort (it depends on when the request
    // event arrives); the invariant is that the new document never gets this burst's keys.
    await send(keys("abc").concat({ kind: "press", key: "Enter" }, ...keys("def")));
    await page.waitForURL(/\/b\?q=abc$/);
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    expect(await page.locator("#r").inputValue()).toBe("");

    // The next burst opens a fresh session on the checked document.
    expect(await send(keys("xy"))).toMatchObject({ sent: 2 });
    expect(await page.locator("#r").inputValue()).toBe("xy");
  });

  it("makes input wait for a finishing session and reports its late denial", async () => {
    const { page, send } = await openFormPage();
    expect(await send(keys("n"))).toMatchObject({ sent: 1 });
    // The page starts a blocked navigation after that burst was answered. Input sent
    // while the session's guard is still settling waits for it and gets the denial.
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    await expect(send(keys("z"))).rejects.toThrow(/blocked|private|not allowed/i);
    expect(new URL(page.url()).pathname).toBe("/a");
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
