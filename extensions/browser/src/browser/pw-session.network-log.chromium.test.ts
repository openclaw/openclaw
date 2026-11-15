import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { launchChromium, readTargetId } from "./pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { getNetworkRequestsViaPlaywright } from "./pw-tools-core.activity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_RESPONSE_E2E === "1")("CDP network metadata", () => {
  it("keeps worker traffic and successful no-content navigations in the page log", async () => {
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/worker.js") {
        res
          .setHeader("Content-Type", "text/javascript")
          .end(
            "fetch('/worker-post', {method:'POST', body:'synthetic'}).then(() => postMessage('done'));",
          );
      } else if (req.url === "/empty") {
        res.writeHead(204).end();
      } else {
        res.end("<title>Synthetic network fixture</title>");
      }
    });
    const port = await listenOnLoopback(server);
    const { context, cdpUrl } = await launchChromium(tempDirs.make("openclaw-network-log-"));
    try {
      const page = context.pages()[0]!;
      const targetId = await readTargetId(page);
      await getPageForTargetId({ cdpUrl, targetId });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const worker = new Worker("/worker.js");
            worker.addEventListener(
              "message",
              () => {
                worker.terminate();
                resolve();
              },
              { once: true },
            );
          }),
      );
      await page.goto(`http://127.0.0.1:${port}/empty`).catch(() => {});
      await expect
        .poll(async () => {
          const { requests } = await getNetworkRequestsViaPlaywright({ cdpUrl, targetId });
          return requests
            .filter(
              (request) => request.url.endsWith("/worker-post") || request.url.endsWith("/empty"),
            )
            .map(({ method, status, ok, failureText }) => ({ method, status, ok, failureText }));
        })
        .toEqual([
          { method: "POST", status: 200, ok: true, failureText: undefined },
          { method: "GET", status: 204, ok: true, failureText: undefined },
        ]);
    } finally {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 20_000);
});
