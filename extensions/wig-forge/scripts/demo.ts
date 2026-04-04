import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { resolveWigForgeConfig } from "../src/config.js";
import { createWigForgeHttpHandler } from "../src/http.js";

const REPO_ROOT = "/Users/alma/openclaw";
const ARTIFACT_DIR = path.join(REPO_ROOT, "output", "live", "wig-forge-demo");
const STORAGE_DIR = path.join(ARTIFACT_DIR, "store");
const HOST_KEY = "veil-demo-host";
const BUYER_KEY = "veil-demo-buyer";

const httpHandler = createWigForgeHttpHandler({
  config: resolveWigForgeConfig({
    storageDir: STORAGE_DIR,
    maxSourceBytes: 8 * 1024 * 1024,
  }),
});

type DemoMintSpec = {
  inventoryKey: string;
  name: string;
  slotHint: "head" | "face" | "body" | "neck" | "companion" | "aura";
  styleTags: string[];
  svg: string;
  novelty: number;
  maskQuality: number;
  taskQuality: number;
  styleFit: number;
  luck: number;
};

type DemoSeedState = {
  hostRoomUrl: string;
  buyerRoomUrl: string;
  hostAssetNames: string[];
  buyerAssetNames: string[];
  listedAssetName: string;
  listedAssetPrice: number;
};

let demoSeedState: DemoSeedState | null = null;

async function main(): Promise<void> {
  await fs.rm(ARTIFACT_DIR, { recursive: true, force: true });
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.port}`;

  demoSeedState = await seedDemo(baseUrl);

  console.log(`Veil demo is live at ${baseUrl}`);
  console.log(`Host room: ${demoSeedState.hostRoomUrl}`);
  console.log(`Buyer room: ${demoSeedState.buyerRoomUrl}`);
  console.log("This is a live page, not a screenshot artifact.");
  console.log("Press Ctrl+C to stop the demo server.");

  const shutdown = async () => {
    await stopServer(server.server);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

async function seedDemo(baseUrl: string): Promise<DemoSeedState> {
  const hostAssets = [
    await mintDemoAsset(baseUrl, {
      inventoryKey: HOST_KEY,
      name: "Lumen Veil Crown",
      slotHint: "head",
      styleTags: ["ceremony", "crown", "luminous"],
      svg: buildCrownSvg(),
      novelty: 0.94,
      maskQuality: 0.98,
      taskQuality: 0.96,
      styleFit: 0.91,
      luck: 0.88,
    }),
    await mintDemoAsset(baseUrl, {
      inventoryKey: HOST_KEY,
      name: "Ribbon Vow",
      slotHint: "neck",
      styleTags: ["ribbon", "formal", "silk"],
      svg: buildRibbonSvg(),
      novelty: 0.82,
      maskQuality: 0.97,
      taskQuality: 0.93,
      styleFit: 0.84,
      luck: 0.74,
    }),
    await mintDemoAsset(baseUrl, {
      inventoryKey: HOST_KEY,
      name: "Halo Draft",
      slotHint: "aura",
      styleTags: ["halo", "mist", "glow"],
      svg: buildHaloSvg(),
      novelty: 0.78,
      maskQuality: 0.95,
      taskQuality: 0.9,
      styleFit: 0.8,
      luck: 0.72,
    }),
    await mintDemoAsset(baseUrl, {
      inventoryKey: HOST_KEY,
      name: "Glass Familiar",
      slotHint: "companion",
      styleTags: ["familiar", "glass", "lantern"],
      svg: buildFamiliarSvg(),
      novelty: 0.9,
      maskQuality: 0.96,
      taskQuality: 0.92,
      styleFit: 0.89,
      luck: 0.77,
    }),
  ];

  const buyerAssets = [
    await mintDemoAsset(baseUrl, {
      inventoryKey: BUYER_KEY,
      name: "Guest Monocle",
      slotHint: "face",
      styleTags: ["monocle", "guest", "polished"],
      svg: buildMonocleSvg(),
      novelty: 0.66,
      maskQuality: 0.95,
      taskQuality: 0.88,
      styleFit: 0.71,
      luck: 0.51,
    }),
  ];

  await postJson(baseUrl, "/plugins/wig-forge/equip", {
    inventoryKey: HOST_KEY,
    assetId: hostAssets[0].id,
  });
  await postJson(baseUrl, "/plugins/wig-forge/equip", {
    inventoryKey: HOST_KEY,
    assetId: hostAssets[1].id,
  });

  const grantedWish = await postJson(baseUrl, "/plugins/wig-forge/wishes", {
    inventoryKey: HOST_KEY,
    title: "A lantern companion with a soft glass tail",
    slot: "companion",
    desiredRarity: "rare",
    styleTags: ["lantern", "glass", "soft-light"],
    note: "Reward the bot with something that feels prized, social, and alive.",
    requestedBy: "openclaw-bot",
  });

  await postJson(baseUrl, "/plugins/wig-forge/grant", {
    inventoryKey: HOST_KEY,
    wishId: grantedWish.wish.id,
    assetId: hostAssets[3].id,
  });

  await postJson(baseUrl, "/plugins/wig-forge/wishes", {
    inventoryKey: HOST_KEY,
    title: "A mythic halo with a cleaner silver edge",
    slot: "aura",
    desiredRarity: "mythic",
    styleTags: ["halo", "silver", "mythic"],
    note: "Left active on purpose so the Pulse board still shows desire, not just possession.",
    requestedBy: "openclaw-bot",
  });

  const listedAssetPrice = 128;
  await postJson(baseUrl, "/plugins/wig-forge/market/list", {
    inventoryKey: HOST_KEY,
    assetId: hostAssets[2].id,
    priceWig: listedAssetPrice,
    note: "Seeded in the bazaar so the buyer room has a real listing to acquire.",
  });

  return {
    hostRoomUrl: `${baseUrl}/plugins/wig-forge/room?inventoryKey=${encodeURIComponent(HOST_KEY)}`,
    buyerRoomUrl: `${baseUrl}/plugins/wig-forge/room?inventoryKey=${encodeURIComponent(BUYER_KEY)}`,
    hostAssetNames: hostAssets.map((asset) => asset.name),
    buyerAssetNames: buyerAssets.map((asset) => asset.name),
    listedAssetName: hostAssets[2].name,
    listedAssetPrice,
  };
}

async function mintDemoAsset(baseUrl: string, spec: DemoMintSpec) {
  const response = await postJson(baseUrl, "/plugins/wig-forge/forge", {
    inventoryKey: spec.inventoryKey,
    nameHint: spec.name,
    slotHint: spec.slotHint,
    styleTags: spec.styleTags,
    sourceDataUrl: svgToDataUrl(spec.svg),
    novelty: spec.novelty,
    maskQuality: spec.maskQuality,
    taskQuality: spec.taskQuality,
    styleFit: spec.styleFit,
    luck: spec.luck,
  });
  return response.asset;
}

async function postJson(baseUrl: string, pathname: string, payload: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error || `Request failed for ${pathname}`);
  }
  return data;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
    throw new Error("Could not resolve demo server address.");
  }

  return {
    server,
    port: address.port,
  };
}

function handleStaticRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (url.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderDemoIndexPage(url.origin));
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

function renderDemoIndexPage(origin: string): string {
  const hostRoomUrl =
    demoSeedState?.hostRoomUrl ||
    `${origin}/plugins/wig-forge/room?inventoryKey=${encodeURIComponent(HOST_KEY)}`;
  const buyerRoomUrl =
    demoSeedState?.buyerRoomUrl ||
    `${origin}/plugins/wig-forge/room?inventoryKey=${encodeURIComponent(BUYER_KEY)}`;
  const listedAssetName = demoSeedState?.listedAssetName || "Halo Draft";
  const listedAssetPrice = demoSeedState?.listedAssetPrice || 128;
  const hostAssets = (demoSeedState?.hostAssetNames || []).join(" · ");
  const buyerAssets = (demoSeedState?.buyerAssetNames || []).join(" · ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Veil Demo</title>
    <style>
      :root {
        color-scheme: light;
        --paper: #f8f4eb;
        --ink: #1d1914;
        --muted: rgba(29, 25, 20, 0.66);
        --line: rgba(29, 25, 20, 0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Avenir Next", "Helvetica Neue", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(215, 122, 40, 0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(166, 77, 121, 0.16), transparent 28%),
          linear-gradient(180deg, #fffdf8 0%, #f5ede1 42%, #eadbca 100%);
      }
      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 48px 0 72px;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 12px;
        border-radius: 999px;
        background: rgba(29, 25, 20, 0.06);
        color: rgba(29, 25, 20, 0.7);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1, h2, p {
        margin: 0;
      }
      h1 {
        margin-top: 18px;
        max-width: 10ch;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: clamp(3rem, 7vw, 5.4rem);
        line-height: 0.92;
        letter-spacing: -0.06em;
      }
      .lead {
        margin-top: 16px;
        max-width: 42rem;
        color: var(--muted);
        font-size: 1.04rem;
        line-height: 1.7;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 20px;
        margin-top: 28px;
      }
      .card {
        padding: 24px;
        border-radius: 30px;
        border: 1px solid var(--line);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(255, 255, 255, 0.56)),
          linear-gradient(135deg, rgba(215, 122, 40, 0.08), rgba(166, 77, 121, 0.06));
        box-shadow: 0 24px 56px rgba(37, 22, 14, 0.08);
      }
      .card h2 {
        margin-top: 14px;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 2rem;
        line-height: 0.98;
        letter-spacing: -0.04em;
      }
      .meta {
        margin-top: 12px;
        color: var(--muted);
        line-height: 1.6;
      }
      .cta-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 20px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 18px;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      .button.primary {
        background: linear-gradient(135deg, #d77a28, #a64d79);
        color: #fffaf4;
        box-shadow: 0 18px 36px rgba(166, 77, 121, 0.22);
      }
      .button.ghost {
        border: 1px solid rgba(29, 25, 20, 0.12);
        color: var(--ink);
        background: rgba(255, 255, 255, 0.54);
      }
      .note {
        margin-top: 24px;
        padding: 18px 20px;
        border-radius: 22px;
        border: 1px dashed rgba(29, 25, 20, 0.14);
        background: rgba(255, 255, 255, 0.42);
        color: var(--muted);
        line-height: 1.7;
      }
      @media (max-width: 900px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Veil Live Demo</div>
      <h1>This one is actually clickable.</h1>
      <p class="lead">
        The two rooms below are live wig-forge pages running against a seeded local store.
        They are not smoke screenshots. Host room has a granted companion wish and a real bazaar listing.
        Buyer room can purchase ${listedAssetName} for ${listedAssetPrice} wig.
      </p>
      <div class="grid">
        <section class="card">
          <div class="eyebrow">Host Room</div>
          <h2>Glint, Figure, Trace, Pulse, Bazaar.</h2>
          <p class="meta">Seeded host pieces: ${hostAssets || "Loading..."}</p>
          <div class="cta-row">
            <a class="button primary" href="${hostRoomUrl}">Open Host Room</a>
            <a class="button ghost" href="${origin}/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(HOST_KEY)}">View Host JSON</a>
          </div>
        </section>
        <section class="card">
          <div class="eyebrow">Buyer Room</div>
          <h2>Acquire the listed aura and test the transfer.</h2>
          <p class="meta">Seeded buyer pieces: ${buyerAssets || "Loading..."}</p>
          <div class="cta-row">
            <a class="button primary" href="${buyerRoomUrl}">Open Buyer Room</a>
            <a class="button ghost" href="${origin}/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(BUYER_KEY)}">View Buyer JSON</a>
          </div>
        </section>
      </div>
      <div class="note">
        If you want to inspect the raw files, the seeded store lives at <code>${STORAGE_DIR}</code>.
        This page exists specifically to replace the misleading smoke screenshots with a real preview surface.
      </div>
    </main>
  </body>
</html>`;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function buildCrownSvg(): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="280" height="220" viewBox="0 0 280 220">
      <defs>
        <linearGradient id="c1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffe2a7" />
          <stop offset="100%" stop-color="#f08aa8" />
        </linearGradient>
      </defs>
      <g transform="translate(20 28)">
        <path d="M28 110c7-38 41-70 92-70 27 0 48 9 65 24 15 13 26 29 31 46l-20 3c-8-31-34-52-76-52-43 0-68 21-75 52z" fill="url(#c1)" />
        <path d="M12 121c0-10 8-18 18-18h180c10 0 18 8 18 18s-8 18-18 18H30c-10 0-18-8-18-18z" fill="url(#c1)" />
        <path d="M60 101l23-38 34 30 24-49 31 48 32-26 18 35-15 13-38-18-28 30-23-33-30 21z" fill="#fff7df" opacity="0.94" />
        <circle cx="83" cy="79" r="8" fill="#fff3b0" />
        <circle cx="142" cy="58" r="10" fill="#ffe0f0" />
        <circle cx="194" cy="82" r="7" fill="#fff3b0" />
      </g>
    </svg>
  `.trim();
}

function buildRibbonSvg(): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
      <defs>
        <linearGradient id="r1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#34435f" />
        </linearGradient>
        <linearGradient id="r2" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ffc178" />
          <stop offset="100%" stop-color="#f48fb1" />
        </linearGradient>
      </defs>
      <g transform="translate(22 42)">
        <path d="M16 46c0-18 15-33 33-33h102c18 0 33 15 33 33s-15 33-33 33H49C31 79 16 64 16 46z" fill="url(#r1)" />
        <path d="M92 54c0-15 12-27 27-27 15 0 27 12 27 27s-12 27-27 27c-15 0-27-12-27-27z" fill="url(#r2)" />
        <path d="M100 78l-26 58 35-22 11 30 11-30 35 22-27-58z" fill="#f6d6a7" />
      </g>
    </svg>
  `.trim();
}

function buildHaloSvg(): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280">
      <defs>
        <radialGradient id="h1" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#fff8d9" stop-opacity="0.95" />
          <stop offset="68%" stop-color="#ffe5af" stop-opacity="0.66" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
      </defs>
      <g transform="translate(18 18)">
        <circle cx="122" cy="122" r="110" fill="url(#h1)" />
        <ellipse cx="122" cy="122" rx="92" ry="58" fill="none" stroke="#fff4cb" stroke-width="18" opacity="0.92" />
        <ellipse cx="122" cy="122" rx="92" ry="58" fill="none" stroke="#f9a8d4" stroke-width="5" opacity="0.6" />
      </g>
    </svg>
  `.trim();
}

function buildFamiliarSvg(): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="280" viewBox="0 0 240 280">
      <defs>
        <linearGradient id="f1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fef3c7" />
          <stop offset="100%" stop-color="#e9d5ff" />
        </linearGradient>
      </defs>
      <g transform="translate(42 28)">
        <path d="M78 0l19 28 34 6-22 24 5 34-31-15-31 15 5-34-22-24 34-6z" fill="#fff4c7" />
        <path d="M79 76c31 0 56 26 56 57 0 24-14 44-34 52l18 37-22 8-21-33-21 33-22-8 18-37c-20-8-34-28-34-52 0-31 25-57 56-57z" fill="url(#f1)" />
        <circle cx="62" cy="128" r="6" fill="#43314d" />
        <circle cx="96" cy="128" r="6" fill="#43314d" />
        <path d="M66 148c9 8 19 12 30 12 11 0 21-4 30-12" fill="none" stroke="#43314d" stroke-width="6" stroke-linecap="round" />
      </g>
    </svg>
  `.trim();
}

function buildMonocleSvg(): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="220" viewBox="0 0 240 220">
      <g transform="translate(28 30)">
        <circle cx="78" cy="76" r="54" fill="none" stroke="#f5e6c7" stroke-width="16" />
        <circle cx="78" cy="76" r="35" fill="rgba(191,219,254,0.42)" stroke="#f8fafc" stroke-width="4" />
        <path d="M130 72h48" stroke="#f5e6c7" stroke-width="10" stroke-linecap="round" />
        <path d="M75 132l-10 54" stroke="#f5e6c7" stroke-width="6" stroke-linecap="round" />
      </g>
    </svg>
  `.trim();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
