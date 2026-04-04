import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import { resolveWigForgeConfig } from "./config.js";
import { createWigForgeHttpHandler } from "./http.js";

describe("wig-forge http handler", () => {
  it("serves health and inventory endpoints", async () => {
    const handler = await createIsolatedHandler();

    const healthRes = createMockServerResponse();
    const healthHandled = await handler(
      createRequest({
        method: "GET",
        url: "/plugins/wig-forge/health",
        headers: { origin: "chrome-extension://test" },
      }),
      healthRes,
    );
    expect(healthHandled).toBe(true);
    expect(healthRes.statusCode).toBe(200);
    expect(String(healthRes.body)).toContain('"ready":true');

    const inventoryRes = createMockServerResponse();
    const inventoryHandled = await handler(
      createRequest({
        method: "GET",
        url: "/plugins/wig-forge/inventory?inventoryKey=web-bot",
        headers: { origin: "chrome-extension://test" },
      }),
      inventoryRes,
    );
    expect(inventoryHandled).toBe(true);
    expect(inventoryRes.statusCode).toBe(200);
    expect(String(inventoryRes.body)).toContain('"inventoryKey":"web-bot"');

    const roomRes = createMockServerResponse();
    const roomHandled = await handler(
      createRequest({
        method: "GET",
        url: "/plugins/wig-forge/room?inventoryKey=web-bot",
        headers: { origin: "chrome-extension://test" },
      }),
      roomRes,
    );
    expect(roomHandled).toBe(true);
    expect(roomRes.statusCode).toBe(200);
    expect(roomRes.getHeader("content-type")).toContain("text/html");
    expect(String(roomRes.body)).toContain("Veil");
    expect(String(roomRes.body)).toContain("Pulse");
  });

  it("mints an asset over http", async () => {
    const handler = await createIsolatedHandler();
    const png = await sharp({
      create: {
        width: 72,
        height: 72,
        channels: 4,
        background: { r: 255, g: 180, b: 32, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const req = createRequest({
      method: "POST",
      url: "/plugins/wig-forge/forge",
      headers: {
        "content-type": "application/json",
        origin: "chrome-extension://test",
      },
      body: JSON.stringify({
        inventoryKey: "web-bot",
        sourceDataUrl: `data:image/png;base64,${png.toString("base64")}`,
        nameHint: "Forge Sun Halo",
        styleTags: ["aura", "flare"],
        slotHint: "aura",
        luck: 0.84,
      }),
    });
    const res = createMockServerResponse();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('"ok":true');
    expect(String(res.body)).toContain('"slot":"aura"');
  });

  it("equips an asset and serves its preview file over http", async () => {
    const handler = await createIsolatedHandler();
    const png = await sharp({
      create: {
        width: 56,
        height: 56,
        channels: 4,
        background: { r: 244, g: 156, b: 78, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const forgeRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/forge",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "web-bot",
          sourceDataUrl: `data:image/png;base64,${png.toString("base64")}`,
          nameHint: "Room Hat",
          styleTags: ["hat"],
          slotHint: "head",
        }),
      }),
      forgeRes,
    );
    const forged = JSON.parse(String(forgeRes.body));
    const assetId = String(forged.asset.id);

    const equipRes = createMockServerResponse();
    const equipHandled = await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/equip",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "web-bot",
          assetId,
        }),
      }),
      equipRes,
    );
    expect(equipHandled).toBe(true);
    expect(equipRes.statusCode).toBe(200);
    expect(String(equipRes.body)).toContain('"head":"');
    expect(String(equipRes.body)).toContain(assetId);

    const fileRes = createMockServerResponse();
    const fileHandled = await handler(
      createRequest({
        method: "GET",
        url: `/plugins/wig-forge/file?inventoryKey=web-bot&assetId=${encodeURIComponent(assetId)}&kind=preview`,
        headers: { origin: "chrome-extension://test" },
      }),
      fileRes,
    );
    expect(fileHandled).toBe(true);
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.getHeader("content-type")).toBe("image/png");
  });

  it("records and grants a wish over http", async () => {
    const handler = await createIsolatedHandler();
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 252, g: 217, b: 142, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const forgeRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/forge",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "wish-bot",
          sourceDataUrl: `data:image/png;base64,${png.toString("base64")}`,
          nameHint: "Wish Crown",
          styleTags: ["formal", "crown"],
          slotHint: "head",
        }),
      }),
      forgeRes,
    );
    const forged = JSON.parse(String(forgeRes.body));
    const assetId = String(forged.asset.id);

    const wishRes = createMockServerResponse();
    const wishHandled = await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/wishes",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "wish-bot",
          title: "Ceremonial crown",
          slot: "head",
          desiredRarity: "rare",
          requestedBy: "wishful-bot",
        }),
      }),
      wishRes,
    );
    expect(wishHandled).toBe(true);
    expect(wishRes.statusCode).toBe(200);
    expect(String(wishRes.body)).toContain('"inventoryKey":"wish-bot"');
    const wished = JSON.parse(String(wishRes.body));
    const wishId = String(wished.wish.id);

    const grantRes = createMockServerResponse();
    const grantHandled = await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/grant",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "wish-bot",
          wishId,
          assetId,
        }),
      }),
      grantRes,
    );
    expect(grantHandled).toBe(true);
    expect(grantRes.statusCode).toBe(200);
    expect(String(grantRes.body)).toContain('"grantedAssetId":"');
    expect(String(grantRes.body)).toContain(assetId);
  });

  it("lists and purchases an asset through the bazaar over http", async () => {
    const handler = await createIsolatedHandler();
    const png = await sharp({
      create: {
        width: 68,
        height: 68,
        channels: 4,
        background: { r: 247, g: 184, b: 114, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const forgeRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/forge",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "seller-bot",
          sourceDataUrl: `data:image/png;base64,${png.toString("base64")}`,
          nameHint: "Bazaar Ribbon",
          styleTags: ["ribbon", "formal"],
          slotHint: "neck",
        }),
      }),
      forgeRes,
    );
    const forged = JSON.parse(String(forgeRes.body));
    const assetId = String(forged.asset.id);

    const listRes = createMockServerResponse();
    const listHandled = await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/market/list",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "seller-bot",
          assetId,
          priceWig: 75,
          note: "for a bot with ceremony in mind",
        }),
      }),
      listRes,
    );
    expect(listHandled).toBe(true);
    expect(listRes.statusCode).toBe(200);
    expect(String(listRes.body)).toContain('"priceWig":75');
    const listed = JSON.parse(String(listRes.body));
    const listingId = String(listed.listing.id);

    const marketRes = createMockServerResponse();
    const marketHandled = await handler(
      createRequest({
        method: "GET",
        url: "/plugins/wig-forge/market?inventoryKey=buyer-bot",
        headers: { origin: "chrome-extension://test" },
      }),
      marketRes,
    );
    expect(marketHandled).toBe(true);
    expect(marketRes.statusCode).toBe(200);
    expect(String(marketRes.body)).toContain('"sellerInventoryKey":"seller-bot"');

    const buyRes = createMockServerResponse();
    const buyHandled = await handler(
      createRequest({
        method: "POST",
        url: "/plugins/wig-forge/market/buy",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://test",
        },
        body: JSON.stringify({
          inventoryKey: "buyer-bot",
          listingId,
        }),
      }),
      buyRes,
    );
    expect(buyHandled).toBe(true);
    expect(buyRes.statusCode).toBe(200);
    expect(String(buyRes.body)).toContain('"status":"sold"');
    expect(String(buyRes.body)).toContain('"wigBalance":165');

    const buyerInventoryRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: "/plugins/wig-forge/inventory?inventoryKey=buyer-bot",
        headers: { origin: "chrome-extension://test" },
      }),
      buyerInventoryRes,
    );
    expect(String(buyerInventoryRes.body)).toContain(assetId);

    const sellerInventoryRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: "/plugins/wig-forge/inventory?inventoryKey=seller-bot",
        headers: { origin: "chrome-extension://test" },
      }),
      sellerInventoryRes,
    );
    expect(String(sellerInventoryRes.body)).toContain('"wigBalance":315');
  });
});

async function createIsolatedHandler() {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "wig-forge-http-test-"));
  return createWigForgeHttpHandler({
    config: resolveWigForgeConfig({ storageDir }),
  });
}

function createRequest(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = input.method;
  req.url = input.url;
  req.headers = input.headers ?? {};
  req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as IncomingMessage["destroy"];
  process.nextTick(() => {
    if (input.body) {
      req.emit("data", Buffer.from(input.body));
    }
    req.emit("end");
    req.emit("close");
  });
  return req;
}
