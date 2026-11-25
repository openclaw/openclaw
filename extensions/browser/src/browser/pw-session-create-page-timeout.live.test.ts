import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  getPageForTargetId,
} from "./pw-session.js";

describe.skipIf(!isLiveTestEnabled())(
  "create-page committed timeout recovery (real Chromium)",
  () => {
    let admin: BrowserContext;
    let cdpUrl: string;
    let rootDir: string;
    let streamUrl: string;
    const held = new Set<ServerResponse>();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.write("<!doctype html><title>Committed stream</title><body>ready</body>");
      held.add(res);
      res.on("close", () => held.delete(res));
    });

    beforeAll(async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-create-page-timeout-"));
      const profileDir = path.join(rootDir, "chromium-profile");
      admin = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ["--remote-debugging-port=0", "--no-proxy-server"],
      });
      const port = (await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0];
      cdpUrl = `http://127.0.0.1:${port}`;
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Streaming fixture did not bind");
      }
      streamUrl = `http://127.0.0.1:${address.port}/stream`;
    }, 30_000);

    afterAll(async () => {
      for (const response of held) {
        response.destroy();
      }
      await closePlaywrightBrowserConnection({ cdpUrl }).catch(() => {});
      await admin?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(rootDir, { recursive: true, force: true });
    });

    it("returns the committed tab after stopping an unfinished document", async () => {
      const owned = await createPageViaPlaywright({
        cdpUrl,
        url: streamUrl,
        timeoutMs: 1_000,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });
      try {
        expect(owned.url).toBe(streamUrl);
        const page = await getPageForTargetId({ cdpUrl, targetId: owned.targetId });
        expect(await page.title()).toBe("Committed stream");
        expect(await page.locator("body").textContent()).toBe("ready");
      } finally {
        await owned.close();
      }
    }, 15_000);
  },
);
