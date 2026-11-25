import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import {
  gotoPageWithNavigationGuard,
  withPageNavigationRequestGuard,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
} from "./pw-session-navigation.js";

describe.skipIf(!isLiveTestEnabled())(
  "document guard preserves native CORS (real Chromium)",
  () => {
    let browser: Browser;
    let ports: Awaited<ReturnType<typeof acquireTestPortBlock>>;
    let sourceUrl: string;
    let targetUrl: string;
    const methods: string[] = [];
    const heldResponses = new Set<ServerResponse>();
    let documents = 0;
    const source = createServer((req, res) => {
      if (req.url === "/finite" || req.url === "/finite-child") {
        const child = req.url === "/finite-child";
        heldResponses.add(res);
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.write(
          child
            ? "<!doctype html><title>Pending child</title><body>child prefix"
            : '<!doctype html><title>Pending main</title><body><iframe src="/finite-child"></iframe>',
        );
        const timer = setTimeout(
          () => {
            res.end(
              child
                ? '<p id="child-tail">child complete</p></body>'
                : '<form id="main-tail">main complete</form><script>document.title="Finite complete"</script></body>',
            );
          },
          child ? 2_000 : 1_500,
        );
        res.on("close", () => {
          clearTimeout(timer);
          heldResponses.delete(res);
        });
        return;
      }
      if (req.url === "/stream") {
        heldResponses.add(res);
        const timer = setTimeout(() => {
          if (res.destroyed) {
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
          res.write("<!doctype html><title>Committed action stream</title><body>ready</body>");
        }, 1_000);
        res.on("close", () => {
          clearTimeout(timer);
          heldResponses.delete(res);
        });
        return;
      }
      const allowed = req.url === "/allowed";
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        `<title>Source</title><button onclick="probe()">Probe</button><script>
      async function probe() {
        try { await fetch('${targetUrl}/${allowed ? "allowed" : "denied"}', { method: 'PUT', headers: {'Content-Type':'application/json','x-probe':'1'}, body:'{}' }); document.title='allowed'; }
        catch { document.title='denied'; }
      }
      ${req.url?.startsWith("/load") ? "probe();" : ""}</script>`,
      );
    });
    const target = createServer((req, res) => {
      if (req.url === "/document") {
        documents++;
        res.writeHead(200).end("forbidden");
        return;
      }
      methods.push(req.method ?? "");
      if (req.url === "/allowed") {
        res.setHeader("Access-Control-Allow-Origin", sourceUrl);
        res.setHeader("Access-Control-Allow-Methods", "PUT");
        res.setHeader("Access-Control-Allow-Headers", "content-type,x-probe");
      }
      res.writeHead(204).end();
    });
    beforeAll(async () => {
      ports = await acquireTestPortBlock({ offsets: [0, 1] });
      sourceUrl = "http://127.0.0.1:" + ports.port;
      targetUrl = "http://127.0.0.2:" + (ports.port + 1);
      for (const [offset, server] of [source, target].entries()) {
        server.listen(ports.port + offset, offset === 0 ? "127.0.0.1" : "0.0.0.0");
        await once(server, "listening");
      }
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ["--no-proxy-server", "--site-per-process"],
      });
    }, 30_000);
    afterAll(async () => {
      for (const response of heldResponses) {
        response.destroy();
      }
      await browser?.close();
      for (const server of [source, target]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      await ports?.release();
    });
    it.each(["action", "goto"] as const)(
      "%s leaves rejected preflight on the native network path",
      async (owner) => {
        const page = await browser.newPage();
        methods.length = 0;
        const policy = { ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } };
        try {
          if (owner === "action") {
            await page.goto(sourceUrl);
            await withPageNavigationRequestGuard({
              page,
              ...policy,
              action: async () => {
                await page.click("button");
                await page.waitForFunction(() => document.title === "denied");
              },
            });
          } else {
            await gotoPageWithNavigationGuard({
              cdpUrl: sourceUrl,
              page,
              url: sourceUrl + "/load",
              timeoutMs: 5000,
              ...policy,
            });
            await page.waitForFunction(() => document.title === "denied");
          }
          expect(methods).toEqual(["OPTIONS"]);
          if (process.env.OPENCLAW_LIVE_PROOF === "1") {
            console.info(`[browser-proof] cors owner=${owner} methods=OPTIONS put=0`);
          }
        } finally {
          await page.close();
        }
      },
    );
    it("allows consenting CORS and preserves the source on denied document navigation", async () => {
      const page = await browser.newPage();
      methods.length = 0;
      documents = 0;
      try {
        await page.goto(sourceUrl + "/allowed");
        await withPageNavigationRequestGuard({
          page,
          ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
          action: async () => {
            await page.click("button");
            await page.waitForFunction(() => document.title === "allowed");
          },
        });
        expect(methods).toEqual(["OPTIONS", "PUT"]);
        const error = await withPageNavigationRequestGuard({
          page,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
          action: async () => {
            await page.evaluate((url) => {
              location.href = url;
            }, targetUrl + "/document");
          },
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SsrFBlockedError);
        expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(error)).toBe(true);
        expect(documents).toBe(0);
        expect(page.url()).toBe(sourceUrl + "/allowed");
        expect(await page.title()).toBe("allowed");
        if (process.env.OPENCLAW_LIVE_PROOF === "1") {
          console.info(
            "[browser-proof] cors consenting=OPTIONS,PUT deniedDocuments=0 sourcePreserved=true",
          );
        }
      } finally {
        await page.close();
      }
    });
    it("preserves delayed finite HTML and simultaneous pending child loads after success", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(sourceUrl);
        await withPageNavigationRequestGuard({
          page,
          ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
          action: async () => {
            await page.evaluate((url) => {
              location.href = url;
            }, sourceUrl + "/finite");
            await page.waitForURL(sourceUrl + "/finite", { waitUntil: "commit" });
            await page.frameLocator("iframe").locator("body").waitFor();
          },
        });
        expect(await page.locator("#main-tail").count()).toBe(0);
        expect(await page.frameLocator("iframe").locator("#child-tail").count()).toBe(0);
        await page.waitForLoadState("load", { timeout: 5_000 });
        expect(await page.locator("#main-tail").textContent()).toBe("main complete");
        expect(await page.frameLocator("iframe").locator("#child-tail").textContent()).toBe(
          "child complete",
        );
        expect(await page.title()).toBe("Finite complete");
        if (process.env.OPENCLAW_LIVE_PROOF === "1") {
          console.info(
            "[browser-proof] successfulAction pendingMain=true pendingChild=true delayedMain=complete delayedChild=complete load=complete",
          );
        }
      } finally {
        await page.close();
      }
    }, 15_000);
    it("settles a committed action stream before releasing navigation ownership", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(sourceUrl);
        await withPageNavigationRequestGuard({
          page,
          ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
          action: async () => {
            await page.evaluate((url) => {
              location.href = url;
            }, sourceUrl + "/stream");
          },
        });

        expect(page.url()).toBe(sourceUrl + "/stream");
        expect(await page.title()).toBe("Committed action stream");
        await page.goto(sourceUrl + "/after-stream");
        expect(page.url()).toBe(sourceUrl + "/after-stream");
        if (process.env.OPENCLAW_LIVE_PROOF === "1") {
          console.info("[browser-proof] stream committed=true subsequentNavigation=true");
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  },
);
