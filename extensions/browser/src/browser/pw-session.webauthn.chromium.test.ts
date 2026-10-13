import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { createTargetViaCdp } from "./cdp.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  getPageForTargetId,
  prepareHeadlessPasskeyGuard,
} from "./pw-session.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Synthetic sign-in step: the page asks for a passkey and offers another way.
// `?ask=load` asks as soon as the document loads, like a passkey challenge page.
const fixtureHtml = `<!doctype html>
<title>Passkey fixture</title>
<button id="other" style="font-size: 24px">Try another way</button>
<script>
  window.clicks = 0;
  document.getElementById("other").addEventListener("click", () => { window.clicks += 1; });
  window.askForPasskey = (mediation) => {
    window.passkey = "pending";
    navigator.credentials
      .get({ mediation, publicKey: {
        challenge: new Uint8Array(32),
        rpId: location.hostname,
        timeout: 60000,
        allowCredentials: [{ type: "public-key", id: new Uint8Array(32) }],
      } })
      .then(() => { window.passkey = "resolved"; }, (error) => { window.passkey = error.name; });
  };
  if (location.search === "?ask=load") window.askForPasskey();
</script>`;

type FixtureWindow = { clicks: number; passkey?: string; askForPasskey: (m?: string) => void };

const readFixture = async (page: Page) =>
  await page.evaluate(() => {
    const { clicks, passkey } = window as unknown as FixtureWindow;
    return { clicks, passkey };
  });

async function askForPasskey(page: Page, mediation?: "conditional") {
  await page.evaluate((value) => {
    (window as unknown as FixtureWindow).askForPasskey(value);
  }, mediation);
}

/** Chrome raises its hidden dialog shortly after the request; wait until clicks stop landing. */
async function clicksStopLanding(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const before = (await readFixture(page)).clicks;
    await page.click("#other");
    if ((await readFixture(page)).clicks === before) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

async function clickLands(page: Page) {
  const before = (await readFixture(page)).clicks;
  await page.click("#other");
  return (await readFixture(page)).clicks === before + 1;
}

describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "headless passkey requests in Chromium",
  () => {
    it("keeps clicks reaching pages that ask for a passkey", async () => {
      const server = createServer((_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(fixtureHtml);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      // WebAuthn rejects IP-address relying parties; localhost is a secure context.
      const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      const admin = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-passkey-"), "profile"),
        {
          headless: true,
          // chrome-headless-shell has no passkey dialog; the defect needs full Chrome.
          ...(executablePath ? { executablePath } : { channel: "chromium" }),
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        // Precondition, before OpenClaw connects: the hidden dialog swallows clicks.
        const unguarded = await admin.newPage();
        await unguarded.goto(url);
        await askForPasskey(unguarded);
        expect(await clicksStopLanding(unguarded), "unguarded page drops clicks").toBe(true);
        expect((await readFixture(unguarded)).passkey, "unguarded request").toBe("pending");
        await unguarded.close();

        // A document that loaded before OpenClaw connected.
        const loadedEarly = await admin.newPage();
        await loadedEarly.goto(url);

        // A local managed `open`: guard, then raw CDP opens the tab with the script.
        const { firstDocumentScript } = await prepareHeadlessPasskeyGuard({ cdpUrl });
        const created = await createTargetViaCdp({
          cdpUrl,
          url: `${url}?ask=load`,
          ssrfPolicy: { allowPrivateNetwork: true },
          waitForNavigationResult: true,
          firstDocumentScript,
        });
        const opened = await getPageForTargetId({ cdpUrl, targetId: created.targetId });
        await opened.waitForFunction(() => (window as unknown as FixtureWindow).passkey);
        expect((await readFixture(opened)).passkey, "raw-CDP tab request").toBe("NotAllowedError");
        expect(await clickLands(opened), "raw-CDP tab click").toBe(true);

        await askForPasskey(loadedEarly);
        expect((await readFixture(loadedEarly)).passkey, "early page request").toBe(
          "NotAllowedError",
        );
        expect(await clickLands(loadedEarly), "early page click").toBe(true);

        // Only the connection's own launch-mode read guards a new isolated context,
        // so this proves the read through the real transport.
        const isolated = await createPageViaPlaywright({
          cdpUrl,
          url: `${url}?ask=load`,
          isolatedContext: true,
          ssrfPolicy: { allowPrivateNetwork: true },
        });
        const isolatedPage = await getPageForTargetId({ cdpUrl, targetId: isolated.targetId });
        await isolatedPage.waitForFunction(() => (window as unknown as FixtureWindow).passkey);
        expect((await readFixture(isolatedPage)).passkey, "isolated page request").toBe(
          "NotAllowedError",
        );
        expect(await clickLands(isolatedPage), "isolated page click").toBe(true);
        await isolated.close();

        // Lookups, snapshots and the screencast attach and detach page sessions;
        // Chrome drops DevTools WebAuthn overrides on detach, the script stays.
        await (await opened.context().newCDPSession(opened)).detach();
        await opened.goto(`${url}?ask=load`);
        await opened.waitForFunction(() => (window as unknown as FixtureWindow).passkey);
        expect((await readFixture(opened)).passkey, "reloaded tab request").toBe("NotAllowedError");
        expect(await clickLands(opened), "reloaded tab click").toBe(true);

        const popupOpened = opened.waitForEvent("popup");
        await opened.evaluate((target) => {
          window.open(target);
        }, url);
        const popup = await popupOpened;
        await popup.waitForLoadState();
        // Autofill passkey requests open no dialog and stay with Chrome.
        await askForPasskey(popup, "conditional");
        expect(await clickLands(popup), "popup click with autofill request").toBe(true);
        expect((await readFixture(popup)).passkey, "popup autofill request").toBe("pending");
        await askForPasskey(popup);
        expect((await readFixture(popup)).passkey, "popup request").toBe("NotAllowedError");
        expect(await clickLands(popup), "popup click").toBe(true);
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await admin.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }, 90_000);
  },
);
