import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Request } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { evaluateViaPlaywright } from "./pw-tools-core.interactions.actions.js";

function waitForDocumentSettled(page: Page, url: string): Promise<void> {
  return new Promise((resolve) => {
    const settled = (request: Request) => {
      if (request.url() !== url) return;
      page.off("requestfinished", settled);
      page.off("requestfailed", settled);
      resolve();
    };
    // Chromium reports a synthetic 204 navigation as aborted on some builds.
    page.on("requestfinished", settled);
    page.on("requestfailed", settled);
  });
}

describe.skipIf(!isLiveTestEnabled())("standing document policy over real CDP", () => {
  let context: BrowserContext;
  let page: Page;
  let root: string;
  let cdpUrl: string;
  let targetId: string;
  let sourceUrl: string;
  let deniedUrl: string;
  let deniedRequests = 0;
  const source = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end("<!doctype html><title>source</title><p>source document</p>");
  });
  const denied = createServer((_req, res) => {
    deniedRequests += 1;
    res.writeHead(200, { "Content-Type": "text/html" }).end("<title>denied</title>");
  });
  const policy = { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] };

  beforeAll(async () => {
    for (const server of [source, denied]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const sourceAddress = source.address();
    const deniedAddress = denied.address();
    if (
      !sourceAddress ||
      typeof sourceAddress === "string" ||
      !deniedAddress ||
      typeof deniedAddress === "string"
    ) {
      throw new Error("fixture bind failed");
    }
    sourceUrl = "http://127.0.0.1:" + sourceAddress.port + "/";
    deniedUrl = "http://localhost:" + deniedAddress.port + "/denied";
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-standing-policy-"));
    context = await chromium.launchPersistentContext(root, {
      headless: true,
      args: [
        "--remote-debugging-port=0",
        "--no-proxy-server",
        "--site-per-process",
        "--host-resolver-rules=MAP deny.test 127.0.0.1",
      ],
    });
    const port = (await fs.readFile(path.join(root, "DevToolsActivePort"), "utf8")).split("\n")[0];
    cdpUrl = "http://127.0.0.1:" + port;
    page = await context.newPage();
    const session = await context.newCDPSession(page);
    ({
      targetInfo: { targetId },
    } = await session.send("Target.getTargetInfo"));
    await session.detach();
    await getPageForTargetId({
      cdpUrl,
      targetId,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    await page.goto(sourceUrl);
  }, 30_000);

  afterAll(async () => {
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context?.close();
    for (const server of [source, denied]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("blocks a document triggered after the production action has returned", async () => {
    await evaluateViaPlaywright({
      cdpUrl,
      targetId,
      ssrfPolicy: policy,
      fn:
        "() => { window.addEventListener('late-navigation', () => { location.href = " +
        JSON.stringify(deniedUrl) +
        "; }, { once: true }); return 'armed'; }",
    });
    // Release only after the complete action/grace returns. Network completion,
    // not a sleep, proves the denied load settled.
    const adapterPage = await getPageForTargetId({ cdpUrl, targetId });
    const completed = waitForDocumentSettled(adapterPage, deniedUrl);
    await page.evaluate(() => window.dispatchEvent(new Event("late-navigation")));
    await completed;
    expect(deniedRequests).toBe(0);
    expect(page.url()).toBe(sourceUrl);
  }, 15_000);
  it("keeps normal same-origin navigation and reload working between calls", async () => {
    await page.goto(sourceUrl + "next");
    await page.reload();
    expect(await page.title()).toBe("source");
    expect(page.url()).toBe(sourceUrl + "next");
    await page.goto(sourceUrl);
  });

  it("expires temporary grants and protects cross-origin frame documents", async () => {
    const before = deniedRequests;
    await evaluateViaPlaywright({
      cdpUrl,
      targetId,
      ssrfPolicy: { ...policy, allowedHostnames: ["127.0.0.1", "localhost"] },
      standingSsrfPolicy: policy,
      fn:
        "async () => { const frame = document.createElement('iframe'); frame.id = 'child'; const loaded = new Promise(resolve => frame.onload = resolve); frame.src = " +
        JSON.stringify(deniedUrl) +
        "; document.body.append(frame); await loaded; return 'loaded'; }",
    });
    expect(deniedRequests).toBe(before + 1);
    const frame = page.frames().find((candidate) => candidate.url() === deniedUrl);
    if (!frame) throw new Error("missing cross-origin fixture frame");
    // The existing frame's own origin remains usable after the grant expires.
    await frame.goto(deniedUrl + "?reload");
    expect(deniedRequests).toBe(before + 2);
    const alias = deniedUrl.replace("localhost", "deny.test");
    const adapterPage = await getPageForTargetId({ cdpUrl, targetId });
    const finished = waitForDocumentSettled(adapterPage, alias);
    await frame.goto(alias).catch(() => {});
    await finished;
    expect(deniedRequests).toBe(before + 2);
    expect(frame.url()).toBe(deniedUrl + "?reload");
    await page.locator("#child").evaluate((element) => element.remove());
    const topFinished = waitForDocumentSettled(adapterPage, deniedUrl);
    await page.evaluate((url) => {
      location.href = url;
    }, deniedUrl);
    await topFinished;
    expect(deniedRequests).toBe(before + 2);
    expect(page.url()).toBe(sourceUrl);
  }, 15_000);

  it("blocks direct CDP document navigation and reinstalls after connection retirement", async () => {
    const before = deniedRequests;
    const adapterPage = await getPageForTargetId({ cdpUrl, targetId });
    const finished = waitForDocumentSettled(adapterPage, deniedUrl);
    const session = await context.newCDPSession(page);
    try {
      await session.send("Page.navigate", { url: deniedUrl });
      await finished;
    } finally {
      await session.detach();
    }
    expect(deniedRequests).toBe(before);
    expect(page.url()).toBe(sourceUrl);
    await closePlaywrightBrowserConnection({ cdpUrl });
    await getPageForTargetId({
      cdpUrl,
      targetId,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    await evaluateViaPlaywright({
      cdpUrl,
      targetId,
      ssrfPolicy: policy,
      fn: "() => document.title",
    });
    await page.reload();
    expect(await page.title()).toBe("source");
  }, 15_000);
});
