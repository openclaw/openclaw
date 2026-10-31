import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { connectOverCdpTransport, reattachRelayPage } from "./pw-session-cdp-transport.js";
import { getFreePort } from "./test-port.js";

// Uses real Chromium and a held HTTP response: no renderer stall or mocked CDP replies.
describe.runIf(
  process.env.OPENCLAW_BROWSER_COLD_CONNECT_E2E === "1" ||
    process.env.OPENCLAW_BROWSER_EXTENSION_E2E === "1",
)("Chromium pending first navigation", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    cleanups.length = 0;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Chromium test cleanup failed");
    }
  });

  it("keeps a healthy tab usable during cold connection and recovers the pending target", async () => {
    let releaseResponse: (() => void) | undefined;
    let requestArrived!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    const server = http.createServer((_req, res) => {
      releaseResponse = () => {
        res.end("<title>recovered</title><p>ready</p>");
      };
      requestArrived();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a local HTTP listener");
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-pending-navigation-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const port = await getFreePort();
    const context = await getPlaywrightCore().chromium.launchPersistentContext(root, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`],
    });
    cleanups.push(() => context.close());
    const healthy = context.pages()[0] ?? (await context.newPage());
    await healthy.goto("data:text/html,<title>healthy</title><p>still usable</p>");
    const native = await context.browser()!.newBrowserCDPSession();
    const { targetId } = await native.send("Target.createTarget", {
      url: `http://127.0.0.1:${address.port}/pending`,
    });
    await requestSeen;
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const connected = await connectOverCdpTransport(version.webSocketDebuggerUrl, {
      timeout: 2500,
      headers: {},
      deferInitialAutoAttach: true,
    });
    cleanups.push(() => connected.close());
    const connectedContext = connected.contexts()[0];
    if (!connectedContext) {
      throw new Error("Expected the persistent Chromium context");
    }
    await expect
      .poll(() => connectedContext.pages().some((page) => page.url().startsWith("data:")))
      .toBe(true);
    const healthyPage = connectedContext.pages().find((page) => page.url().startsWith("data:"));
    expect(healthyPage).toBeDefined();
    await expect(healthyPage!.title()).resolves.toBe("healthy");
    await expect(healthyPage!.locator("p").textContent()).resolves.toBe("still usable");

    releaseResponse!();
    await expect
      .poll(async () => {
        const { targetInfo } = await native.send("Target.getTargetInfo", { targetId });
        return targetInfo.url;
      })
      .toBe(`http://127.0.0.1:${address.port}/pending`);
    await reattachRelayPage(connected, targetId, 3000);
    await expect
      .poll(async () => {
        const recovered = connectedContext.pages().find((page) => page.url().endsWith("/pending"));
        return recovered ? await recovered.title() : undefined;
      })
      .toBe("recovered");
    await expect(healthyPage!.title()).resolves.toBe("healthy");
    expect(healthyPage!.isClosed()).toBe(false);
  }, 15000);
});
