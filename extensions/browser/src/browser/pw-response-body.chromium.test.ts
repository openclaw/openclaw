import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { launchChromium, readTargetId } from "./pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { responseBodyViaPlaywright } from "./pw-tools-core.responses.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_RESPONSE_E2E === "1")(
  "Chromium response body deadline",
  () => {
    it("settles a streamed response without closing the tab or consuming late body bytes", async () => {
      const rootDir = tempDirs.make("openclaw-response-deadline-");
      const streams = new Set<ServerResponse>();
      const server = createServer((request, response) => {
        if (request.url === "/api") {
          streams.add(response);
          response.on("close", () => streams.delete(response));
          response.writeHead(200, { "content-type": "text/plain" });
          response.write("incomplete response");
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<button onclick=\"fetch('/api')\">Fetch</button>");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const { context, cdpUrl } = await launchChromium(rootDir);
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(`http://127.0.0.1:${port}`);
        const targetId = await readTargetId(page);
        await getPageForTargetId({ cdpUrl, targetId });
        let outcome: unknown = "pending";
        const result = responseBodyViaPlaywright({
          cdpUrl,
          targetId,
          url: "**/api",
          timeoutMs: 500,
        }).then(
          (value) => (outcome = value),
          (error: unknown) => (outcome = error),
        );
        await page.getByRole("button", { name: "Fetch" }).click();
        await expect.poll(() => streams.size).toBe(1);
        try {
          await expect.poll(() => outcome, { timeout: 2_000 }).toBeInstanceOf(Error);
          expect(String(outcome)).toMatch(/timed out|timeout/i);
          expect(page.isClosed()).toBe(false);
        } finally {
          for (const stream of streams) {
            stream.end("late bytes");
          }
          await result;
        }
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
        for (const stream of streams) {
          stream.destroy();
        }
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
