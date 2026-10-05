import { once } from "node:events";
import { createServer } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import {
  gotoPageWithNavigationGuard,
  withPageNavigationRequestGuard,
} from "./pw-session-navigation.js";

// Playwright's page.route deliberately omits HTTP redirect hops. This contract
// needs real Chromium and two HTTP endpoints, not synthetic route callbacks.
describe.skipIf(!isLiveTestEnabled())("navigation authority on redirects (real Chromium)", () => {
  let browser: Browser;
  let sourceUrl: string;
  let targetUrl: string;
  let current = true;
  let revokeOnRedirect = false;
  let sourceRequests = 0;
  let releaseRedirect: PromiseWithResolvers<void> | undefined;
  let sourceRequested: PromiseWithResolvers<void> | undefined;
  let targetRequests = 0;
  let iframeRedirect = false;
  let nestedIframe = false;
  const source = createServer((req, res) => {
    if (req.url === "/parent" || req.url === "/root") {
      const frameUrl = sourceUrl
        .replace("127.0.0.1", "localhost")
        .replace("/redirect", nestedIframe ? "/outer" : "/iframe");
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(req.url === "/parent" ? `<iframe src="${frameUrl}"></iframe>` : "<body></body>");
      return;
    }
    if (req.url === "/outer") {
      const frameUrl = sourceUrl.replace("/redirect", "/iframe");
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(`<iframe src="${frameUrl}"></iframe>`);
      return;
    }
    if (req.url === "/iframe") {
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end('<a href="/redirect">Follow redirect</a>');
      return;
    }
    if (req.url !== "/redirect") {
      res.writeHead(204).end();
      return;
    }
    sourceRequests += 1;
    sourceRequested?.resolve();
    const respond = () => {
      if (revokeOnRedirect) {
        current = false;
      }
      const destination = iframeRedirect ? targetUrl.replace("127.0.0.1", "localhost") : targetUrl;
      res.writeHead(302, { Location: destination }).end();
    };
    if (releaseRedirect) {
      void releaseRedirect.promise.then(respond).catch(() => {
        res.destroy();
      });
    } else {
      respond();
    }
  });
  const target = createServer((req, res) => {
    if (req.url === "/target") {
      targetRequests += 1;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end("<title>Redirect target</title>");
  });
  beforeAll(async () => {
    for (const server of [source, target]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const sourceAddress = source.address();
    const targetAddress = target.address();
    if (
      !sourceAddress ||
      typeof sourceAddress === "string" ||
      !targetAddress ||
      typeof targetAddress === "string"
    ) {
      throw new Error("Redirect fixture servers did not bind");
    }
    sourceUrl = `http://127.0.0.1:${sourceAddress.port}/redirect`;
    targetUrl = `http://127.0.0.1:${targetAddress.port}/target`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ["--no-proxy-server", "--site-per-process"],
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    for (const server of [source, target]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each([
    { owner: "goto", revoke: false },
    { owner: "goto", revoke: true },
    { owner: "selected-page action", revoke: false },
    { owner: "selected-page action", revoke: true },
    { owner: "early-returning action", revoke: false },
    { owner: "early-returning action", revoke: true },
    { owner: "existing iframe", revoke: false },
    { owner: "existing iframe", revoke: true },
    { owner: "new iframe", revoke: false },
    { owner: "new iframe", revoke: true },
    { owner: "nested iframe", revoke: false },
    { owner: "nested iframe", revoke: true },
  ])("$owner fences each redirect (revoke=$revoke)", async ({ owner, revoke }) => {
    const early = owner === "early-returning action";
    const iframe =
      owner === "existing iframe" || owner === "new iframe" || owner === "nested iframe";
    iframeRedirect = iframe;
    nestedIframe = owner === "nested iframe";
    releaseRedirect = early ? Promise.withResolvers<void>() : undefined;
    sourceRequested = early ? Promise.withResolvers<void>() : undefined;
    const actionReturned = Promise.withResolvers<void>();
    current = true;
    revokeOnRedirect = revoke;
    sourceRequests = 0;
    targetRequests = 0;
    const page = await browser.newPage();
    const policy = {
      ssrfPolicy: { allowedHostnames: ["127.0.0.1", "localhost"] },
      assertNavigationCurrent: () => {
        if (!current) {
          throw new Error("invocation revoked during redirect");
        }
      },
    };
    try {
      if (iframe) {
        await page.goto(
          sourceUrl.replace("/redirect", owner === "new iframe" ? "/root" : "/parent"),
        );
      } else {
        await page.setContent(`<a href="${sourceUrl}">Follow redirect</a>`);
      }
      const operation =
        owner === "goto"
          ? gotoPageWithNavigationGuard({
              cdpUrl: sourceUrl,
              page,
              url: sourceUrl,
              timeoutMs: 5_000,
              ...policy,
            })
          : withPageNavigationRequestGuard({
              page,
              ...policy,
              action: async () => {
                if (iframe) {
                  if (owner === "new iframe") {
                    await page.evaluate(
                      (url) => {
                        const element = document.createElement("iframe");
                        element.src = url;
                        document.body.append(element);
                      },
                      sourceUrl.replace("127.0.0.1", "localhost").replace("/redirect", "/iframe"),
                    );
                  }
                  const frameLocator = nestedIframe
                    ? page.frameLocator("iframe").frameLocator("iframe")
                    : page.frameLocator("iframe");
                  await frameLocator.locator("a").waitFor({ timeout: 5_000 });
                  const child = page.frames().find((frame) => frame.url().endsWith("/iframe"));
                  if (!child) {
                    throw new Error("Missing iframe fixture");
                  }
                  const session = await page.context().newCDPSession(child);
                  try {
                    expect((await session.send("Target.getTargetInfo")).targetInfo.type).toBe(
                      "iframe",
                    );
                  } finally {
                    await session.detach();
                  }
                  return await child.click("a", { timeout: 5_000 });
                }
                if (!early) {
                  return await page.click("a", { timeout: 5_000 });
                }
                await page.evaluate(() => document.querySelector("a")?.click());
                await sourceRequested?.promise;
                actionReturned.resolve();
              },
            });
      if (early) {
        await actionReturned.promise;
        // A protocol round-trip lets cleanup observe the unfinished document.
        // The response stays withheld until after the action itself returned.
        await page.title();
        releaseRedirect?.resolve();
      }
      if (revoke) {
        await expect(operation).rejects.toThrow("invocation revoked during redirect");
      } else {
        await operation;
        if (iframe) {
          expect(
            page
              .frames()
              .some((frame) => frame.url() === targetUrl.replace("127.0.0.1", "localhost")),
          ).toBe(true);
        } else {
          expect(page.url()).toBe(targetUrl);
        }
      }
      expect(sourceRequests).toBe(1);
      expect(targetRequests).toBe(revoke ? 0 : 1);
      if (revoke) {
        // A rejected operation must not poison the selected tab for its next owner.
        current = true;
        await gotoPageWithNavigationGuard({
          cdpUrl: sourceUrl,
          page,
          url: targetUrl,
          timeoutMs: 5_000,
          ...policy,
        });
        expect(page.url()).toBe(targetUrl);
        expect(targetRequests).toBe(1);
      }
    } finally {
      releaseRedirect?.resolve();
      await page.close();
    }
  });
});
