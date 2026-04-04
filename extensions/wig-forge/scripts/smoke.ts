import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveWigForgeConfig } from "../src/config.js";
import { createWigForgeHttpHandler } from "../src/http.js";

const REPO_ROOT = "/Users/alma/openclaw";
const EXTENSION_ROOT = path.join(REPO_ROOT, "extensions", "wig-forge");
const EXTENSION_DIR = path.join(EXTENSION_ROOT, "browser-extension");
const ARTIFACT_DIR = path.join(REPO_ROOT, "output", "playwright", "wig-forge");
const STORAGE_DIR = path.join(ARTIFACT_DIR, "store");
const USER_DATA_DIR_PREFIX = path.join(os.tmpdir(), "wig-forge-smoke-");
const INVENTORY_KEY = "smoke-web-bot";
const BUYER_INVENTORY_KEY = "smoke-web-buyer";
const headless = process.env.WIG_FORGE_SMOKE_HEADLESS === "1";
const PLAYWRIGHT_CACHE_DIR = path.join(os.homedir(), "Library", "Caches", "ms-playwright");

const httpHandler = createWigForgeHttpHandler({
  config: resolveWigForgeConfig({
    storageDir: STORAGE_DIR,
    maxSourceBytes: 8 * 1024 * 1024,
  }),
});

const targetSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
  <defs>
    <linearGradient id="cap" x1="0%" x2="100%" y1="0%" y2="100%">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#fb7185"/>
    </linearGradient>
    <linearGradient id="ribbon" x1="0%" x2="100%" y1="0%" y2="0%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <g transform="translate(18 18)">
    <path d="M46 98c7-34 33-56 70-56s63 22 70 56l-18 2c-5-24-25-39-52-39s-47 15-52 39z" fill="url(#cap)"/>
    <path d="M22 108c0-9 8-17 17-17h148c9 0 17 8 17 17 0 9-8 17-17 17H39c-9 0-17-8-17-17z" fill="url(#cap)"/>
    <path d="M78 101h66c7 0 13 6 13 13 0 7-6 13-13 13H78c-7 0-13-6-13-13 0-7 6-13 13-13z" fill="url(#ribbon)"/>
    <circle cx="110" cy="114" r="9" fill="#fde68a"/>
    <path d="M150 84l17-15 13 15-10 8z" fill="#fda4af"/>
    <path d="M164 82l18-25 8 8-17 23z" fill="#fecdd3"/>
  </g>
</svg>
`.trim();

async function main(): Promise<void> {
  await fs.rm(ARTIFACT_DIR, { recursive: true, force: true });
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const userDataDir = await fs.mkdtemp(USER_DATA_DIR_PREFIX);
  const executablePath = await resolveChromiumExecutable();

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      viewport: { width: 1440, height: 980 },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });

    const page = await context.newPage();
    page.on("console", (message) => {
      console.log(`[page:${message.type()}] ${message.text()}`);
    });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "01-page.png"), fullPage: true });

    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
    const extensionId = new URL(serviceWorker.url()).host;

    await page.bringToFront();
    await serviceWorker.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        await chrome.storage.local.set({ gatewayBaseUrl, inventoryKey });
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          throw new Error("No active tab to start selection on.");
        }
        await chrome.tabs.sendMessage(tab.id, {
          type: "wig-forge:start-selection",
          gatewayBaseUrl,
          inventoryKey,
        });
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: INVENTORY_KEY },
    );

    await page.locator("text=Veil: hover an element").waitFor({ timeout: 10_000 });
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "02-selection-mode.png"),
      fullPage: true,
    });

    await page.locator("#asset-target").click({ position: { x: 112, y: 110 } });
    const forgeOutcome = await waitForForgeOutcome(page);
    if (forgeOutcome.status === "error") {
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "03-error.png"), fullPage: true });
      throw new Error(forgeOutcome.message);
    }
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "03-preview.png"), fullPage: true });

    await page.locator("[data-role='name']").first().fill("Smoke-Test Solar Ribbon Hat");
    await page.locator("[data-role='slot']").first().selectOption("head");
    await page.locator("[data-role='forge']").first().click();

    await page.locator("text=Wig Forge Drop").waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "04-drop.png"), fullPage: true });

    const inventoryResponse = await page.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        const response = await fetch(
          `${gatewayBaseUrl}/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(inventoryKey)}`,
        );
        return response.json();
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: INVENTORY_KEY },
    );

    const latestAsset = inventoryResponse?.inventory?.assets?.at?.(-1);
    if (!latestAsset?.id) {
      throw new Error("Smoke run completed without a forged asset in inventory.");
    }

    const roomPage = await context.newPage();
    await roomPage.goto(
      `${baseUrl}/plugins/wig-forge/room?inventoryKey=${encodeURIComponent(INVENTORY_KEY)}`,
      { waitUntil: "networkidle" },
    );
    await roomPage
      .locator("#spotlight-panel")
      .getByRole("heading", { name: latestAsset.name })
      .waitFor({ timeout: 30_000 });
    await roomPage.screenshot({ path: path.join(ARTIFACT_DIR, "05-room.png"), fullPage: true });
    await roomPage
      .locator(`.collection [data-role="equip"][data-asset-id="${latestAsset.id}"]`)
      .click();
    await roomPage
      .locator(`.collection [data-role="equip"][data-asset-id="${latestAsset.id}"][disabled]`)
      .waitFor({ timeout: 30_000 });
    await roomPage.screenshot({
      path: path.join(ARTIFACT_DIR, "06-room-equipped.png"),
      fullPage: true,
    });

    const wishTitle = "Ceremonial smoke crown";
    await roomPage.locator("#wish-title").fill(wishTitle);
    await roomPage.locator("#wish-slot").selectOption("head");
    await roomPage.locator("#wish-rarity").selectOption("any");
    await roomPage.locator("#wish-requested-by").fill("smoke-bot");
    await roomPage.locator("#wish-style-tags").fill("ceremony, hat");
    await roomPage.locator("#wish-form button[type='submit']").click();
    await roomPage
      .locator("#active-wishes")
      .getByRole("heading", { name: wishTitle })
      .waitFor({ timeout: 30_000 });
    await roomPage.screenshot({
      path: path.join(ARTIFACT_DIR, "07-room-wish-created.png"),
      fullPage: true,
    });

    await roomPage.locator("[data-role='grant-wish']").first().click();
    await roomPage
      .locator("#granted-wishes")
      .getByRole("heading", { name: wishTitle })
      .waitFor({ timeout: 30_000 });
    await roomPage.screenshot({
      path: path.join(ARTIFACT_DIR, "08-room-wish-granted.png"),
      fullPage: true,
    });

    const equippedInventory = await page.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        const response = await fetch(
          `${gatewayBaseUrl}/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(inventoryKey)}`,
        );
        return response.json();
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: INVENTORY_KEY },
    );

    if (equippedInventory?.inventory?.loadout?.head !== latestAsset.id) {
      throw new Error("Collection room equip action did not persist the head slot.");
    }

    const wishesResponse = await page.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        const response = await fetch(
          `${gatewayBaseUrl}/plugins/wig-forge/wishes?inventoryKey=${encodeURIComponent(inventoryKey)}`,
        );
        return response.json();
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: INVENTORY_KEY },
    );

    const grantedWish = wishesResponse?.wishes?.wishes?.find?.(
      (entry: { title?: string }) => entry.title === wishTitle,
    );
    if (!grantedWish?.grantedAssetId || grantedWish.grantedAssetId !== latestAsset.id) {
      throw new Error("Wish grant did not persist the granted asset link.");
    }

    const salePrice = "95";
    await roomPage.locator("#market-price").fill(salePrice);
    await roomPage.locator("#market-note").fill("smoke sale for a buyer room");
    await roomPage.locator("#market-form button[type='submit']").click();
    await roomPage
      .locator("#market-active")
      .getByRole("heading", { name: latestAsset.name })
      .waitFor({ timeout: 30_000 });
    await roomPage.screenshot({
      path: path.join(ARTIFACT_DIR, "09-room-bazaar-listed.png"),
      fullPage: true,
    });

    const buyerRoomPage = await context.newPage();
    await buyerRoomPage.goto(
      `${baseUrl}/plugins/wig-forge/room?inventoryKey=${encodeURIComponent(BUYER_INVENTORY_KEY)}`,
      { waitUntil: "networkidle" },
    );
    await buyerRoomPage
      .locator("#market-active")
      .getByRole("heading", { name: latestAsset.name })
      .waitFor({ timeout: 30_000 });
    await buyerRoomPage.screenshot({
      path: path.join(ARTIFACT_DIR, "10-buyer-room-market.png"),
      fullPage: true,
    });
    await buyerRoomPage.locator("[data-role='buy-listing']").first().click();
    await buyerRoomPage
      .locator(`.collection [data-role="equip"][data-asset-id="${latestAsset.id}"]`)
      .waitFor({ timeout: 30_000 });
    await buyerRoomPage.screenshot({
      path: path.join(ARTIFACT_DIR, "11-buyer-room-purchased.png"),
      fullPage: true,
    });

    const sellerAfterSale = await page.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        const response = await fetch(
          `${gatewayBaseUrl}/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(inventoryKey)}`,
        );
        return response.json();
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: INVENTORY_KEY },
    );
    const buyerAfterSale = await page.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        const response = await fetch(
          `${gatewayBaseUrl}/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(inventoryKey)}`,
        );
        return response.json();
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: BUYER_INVENTORY_KEY },
    );
    const marketAfterSale = await page.evaluate(
      async ({ gatewayBaseUrl, inventoryKey }) => {
        const response = await fetch(
          `${gatewayBaseUrl}/plugins/wig-forge/market?inventoryKey=${encodeURIComponent(inventoryKey)}`,
        );
        return response.json();
      },
      { gatewayBaseUrl: baseUrl, inventoryKey: BUYER_INVENTORY_KEY },
    );

    if (
      (sellerAfterSale?.inventory?.assets || []).some(
        (entry: { id?: string }) => entry.id === latestAsset.id,
      )
    ) {
      throw new Error("Seller inventory still contains the sold asset.");
    }
    if (
      !(buyerAfterSale?.inventory?.assets || []).some(
        (entry: { id?: string }) => entry.id === latestAsset.id,
      )
    ) {
      throw new Error("Buyer inventory did not receive the purchased asset.");
    }
    const soldEntry = (marketAfterSale?.recentSales || []).find?.(
      (entry: { assetId?: string }) => entry.assetId === latestAsset.id,
    );
    if (!soldEntry) {
      throw new Error("Sold asset did not appear in bazaar history.");
    }
    const salePriceWig = Number(soldEntry.priceWig || 0);
    const sellerWallet = sellerAfterSale?.inventory?.wallet;
    const buyerWallet = buyerAfterSale?.inventory?.wallet;
    const expectedSellerBalance = Number(sellerWallet?.starterGrant || 240) + salePriceWig;
    const expectedBuyerBalance = Number(buyerWallet?.starterGrant || 240) - salePriceWig;

    if (sellerWallet?.wigBalance !== expectedSellerBalance) {
      throw new Error(
        `Seller wig balance mismatch after sale. Expected ${expectedSellerBalance}, received ${sellerWallet?.wigBalance}.`,
      );
    }
    if (buyerWallet?.wigBalance !== expectedBuyerBalance) {
      throw new Error(
        `Buyer wig balance mismatch after purchase. Expected ${expectedBuyerBalance}, received ${buyerWallet?.wigBalance}.`,
      );
    }
    if (sellerWallet?.earnedFromSales !== salePriceWig) {
      throw new Error(
        `Seller earnedFromSales mismatch. Expected ${salePriceWig}, received ${sellerWallet?.earnedFromSales}.`,
      );
    }
    if (buyerWallet?.spentOnPurchases !== salePriceWig) {
      throw new Error(
        `Buyer spentOnPurchases mismatch. Expected ${salePriceWig}, received ${buyerWallet?.spentOnPurchases}.`,
      );
    }

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
    });
    await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, "12-popup.png") });
    await popupPage.close();
    await buyerRoomPage.close();
    await roomPage.close();

    await fs.writeFile(
      path.join(ARTIFACT_DIR, "smoke-summary.json"),
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          extensionId,
          headless,
          inventoryKey: INVENTORY_KEY,
          assetId: latestAsset.id,
          assetName: latestAsset.name,
          rarity: latestAsset.rarity,
          slot: latestAsset.slot,
          captureMode: latestAsset.captureMode,
          equippedHead: equippedInventory?.inventory?.loadout?.head ?? null,
          grantedWishId: grantedWish?.id ?? null,
          sellerWigBalance: sellerAfterSale?.inventory?.wallet?.wigBalance ?? null,
          buyerInventoryKey: BUYER_INVENTORY_KEY,
          buyerWigBalance: buyerAfterSale?.inventory?.wallet?.wigBalance ?? null,
          artifactDir: ARTIFACT_DIR,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      JSON.stringify({
        ok: true,
        artifactDir: ARTIFACT_DIR,
        assetId: latestAsset.id,
        assetName: latestAsset.name,
        rarity: latestAsset.rarity,
        slot: latestAsset.slot,
        captureMode: latestAsset.captureMode,
      }),
    );
  } finally {
    await context?.close().catch(() => {});
    await stopServer(server.server);
  }
}

async function startServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    try {
      if (await httpHandler(req, res)) {
        return;
      }
      handleStaticRequest(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(error instanceof Error ? error.stack || error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve smoke server address.");
  }
  return { server, port: address.port };
}

function handleStaticRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (url.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderSmokePage());
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.statusCode = 204;
    res.end();
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("not found");
}

function renderSmokePage(): string {
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(targetSvg).toString("base64")}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wig Forge Smoke</title>
    <style>
      :root {
        color-scheme: dark;
        --ink: #0f172a;
        --sky: #f8fafc;
        --accent: #fb7185;
        --warm: #f59e0b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Avenir Next", "Helvetica Neue", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(251, 113, 133, 0.25), transparent 32%),
          radial-gradient(circle at bottom right, rgba(245, 158, 11, 0.22), transparent 30%),
          linear-gradient(180deg, #fff7ed 0%, #f8fafc 40%, #e2e8f0 100%);
      }
      main {
        display: grid;
        grid-template-columns: minmax(280px, 420px) minmax(280px, 520px);
        gap: 42px;
        align-items: center;
        min-height: 100vh;
        padding: 56px;
      }
      .copy h1 {
        margin: 0;
        font-size: clamp(2.6rem, 5vw, 4.7rem);
        line-height: 0.92;
        letter-spacing: -0.05em;
      }
      .copy p {
        margin: 18px 0 0;
        font-size: 1.05rem;
        line-height: 1.6;
        max-width: 32rem;
        color: rgba(15, 23, 42, 0.74);
      }
      .eyebrow {
        display: inline-flex;
        margin-bottom: 18px;
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(15, 23, 42, 0.08);
        color: rgba(15, 23, 42, 0.72);
        font-size: 0.78rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .stage {
        position: relative;
        border-radius: 34px;
        padding: 28px;
        background: rgba(255, 255, 255, 0.72);
        box-shadow: 0 32px 80px rgba(15, 23, 42, 0.14);
        overflow: hidden;
      }
      .stage::before,
      .stage::after {
        content: "";
        position: absolute;
        inset: auto;
        border-radius: 50%;
        pointer-events: none;
      }
      .stage::before {
        width: 180px;
        height: 180px;
        top: -54px;
        right: -48px;
        background: rgba(251, 113, 133, 0.16);
      }
      .stage::after {
        width: 240px;
        height: 240px;
        left: -88px;
        bottom: -120px;
        background: rgba(245, 158, 11, 0.18);
      }
      .pedestal {
        position: relative;
        display: grid;
        place-items: center;
        min-height: 420px;
        border-radius: 28px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.56)),
          repeating-linear-gradient(
            135deg,
            rgba(15,23,42,0.04) 0,
            rgba(15,23,42,0.04) 18px,
            transparent 18px,
            transparent 36px
          );
      }
      #asset-target {
        width: 220px;
        height: 220px;
        cursor: pointer;
        user-select: none;
        filter: drop-shadow(0 22px 22px rgba(15, 23, 42, 0.18));
      }
      .caption {
        position: absolute;
        left: 24px;
        right: 24px;
        bottom: 24px;
        display: flex;
        justify-content: space-between;
        gap: 14px;
        color: rgba(15, 23, 42, 0.74);
        font-size: 0.9rem;
      }
      .caption strong {
        display: block;
        color: var(--ink);
      }
      @media (max-width: 980px) {
        main {
          grid-template-columns: 1fr;
          padding: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="copy">
        <div class="eyebrow">Wig Forge Smoke Scene</div>
        <h1>Click the hat. Forge the drop.</h1>
        <p>
          This page is intentionally set up to look like a real marketplace capture:
          a floating accessory with soft shadows, textured surroundings, and enough
          contrast for the browser cutout flow to mint a random OpenClaw wearable.
        </p>
      </section>
      <section class="stage">
        <div class="pedestal">
          <img
            id="asset-target"
            data-wig-forge
            alt="Solar Ribbon Hat"
            title="Solar Ribbon Hat"
            src="${svgDataUrl}"
          />
        </div>
        <div class="caption">
          <div>
            <strong>Target</strong>
            Solar Ribbon Hat
          </div>
          <div>
            <strong>Hint</strong>
            Click near the center band
          </div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForForgeOutcome(page: {
  locator: (selector: string) => {
    waitFor: (options?: { timeout?: number }) => Promise<void>;
    first: () => { textContent: () => Promise<string | null> };
  };
}): Promise<{ status: "preview" } | { status: "error"; message: string }> {
  const previewLocator = page.locator("[data-role='forge']").first();
  const errorLocator = page.locator("text=Veil failed:");

  const winner = await Promise.race([
    previewLocator.waitFor({ timeout: 30_000 }).then(() => ({ status: "preview" as const })),
    errorLocator.waitFor({ timeout: 30_000 }).then(async () => ({
      status: "error" as const,
      message: (await errorLocator.first().textContent()) || "Veil failed during smoke run.",
    })),
  ]);

  return winner;
}

async function resolveChromiumExecutable(): Promise<string> {
  if (process.env.WIG_FORGE_SMOKE_EXECUTABLE) {
    return process.env.WIG_FORGE_SMOKE_EXECUTABLE;
  }

  const browserCandidates = [
    path.join(
      PLAYWRIGHT_CACHE_DIR,
      "chromium-1217",
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ),
  ];

  try {
    const entries = await fs.readdir(PLAYWRIGHT_CACHE_DIR, { withFileTypes: true });
    const chromiumDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const directory of chromiumDirs) {
      browserCandidates.push(
        path.join(
          PLAYWRIGHT_CACHE_DIR,
          directory,
          "chrome-mac-arm64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
      );
      browserCandidates.push(
        path.join(
          PLAYWRIGHT_CACHE_DIR,
          directory,
          "chrome-mac",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
      );
    }
  } catch {}

  for (const candidate of browserCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(
    "No Chromium executable found for the wig-forge smoke run. Run `npx playwright install chromium` or set WIG_FORGE_SMOKE_EXECUTABLE.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
