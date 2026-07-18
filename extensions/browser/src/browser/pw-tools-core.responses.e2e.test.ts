import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

const chromiumExecutablePath = chromium.executablePath();
const describeBrowserE2e = fs.existsSync(chromiumExecutablePath) ? describe : describe.skip;

describeBrowserE2e("pw-tools-core response bodies e2e", () => {
  it("times out a matched body read in a real Chromium session", async () => {
    vi.useRealTimers();

    const openSockets = new Set<net.Socket>();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <body>ready</body>
</html>`);
        return;
      }
      if (url.pathname === "/hang") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.write("partial");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    });

    server.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
      socket.on("error", () => {});
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an IPv4 server address");
    }
    const pageUrl = `http://127.0.0.1:${address.port}/page`;

    const browser: Browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      headless: true,
    });
    const page: Page = await browser.newPage();

    try {
      vi.resetModules();
      vi.doMock("./pw-session.js", () => ({
        ensurePageState: vi.fn(() => {}),
        getPageForTargetId: vi.fn(async () => page),
      }));

      const { responseBodyViaPlaywright } = await import("./pw-tools-core.responses.js");

      const result = responseBodyViaPlaywright({
        cdpUrl: "http://127.0.0.1:1",
        targetId: "T1",
        url: "**/hang",
        timeoutMs: 3_000,
      });

      await Promise.resolve();
      await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        void fetch("/hang").catch(() => {});
      });

      await expect(result).rejects.toThrow(/Response body read timed out after 3000ms/);
    } finally {
      for (const socket of openSockets) {
        socket.destroy();
      }
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
