import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { readJsonBodyWithLimit } from "../../../src/infra/http-body.js";
import type { WigForgeResolvedConfig } from "./config.js";
import { mintForgeAsset, type WigForgeMintInput } from "./forge.js";
import {
  cancelMarketListing,
  createMarketListing,
  purchaseMarketListing,
  summarizeMarketDocument,
} from "./market.js";
import { renderWigForgeRoomPage } from "./room.js";
import {
  WigForgeMarketStore,
  WigForgeStore,
  resolveWigForgeHttpRoot,
  resolveWigForgeMarketRoot,
} from "./store.js";
import type { WigForgeAsset } from "./types.js";
import { createWigForgeWish, type WigForgeWishInput } from "./wishes.js";

const ROUTE_PREFIX = "/plugins/wig-forge";
const HEALTH_PATH = `${ROUTE_PREFIX}/health`;
const FORGE_PATH = `${ROUTE_PREFIX}/forge`;
const INVENTORY_PATH = `${ROUTE_PREFIX}/inventory`;
const EQUIP_PATH = `${ROUTE_PREFIX}/equip`;
const FILE_PATH = `${ROUTE_PREFIX}/file`;
const ROOM_PATH = `${ROUTE_PREFIX}/room`;
const WISHES_PATH = `${ROUTE_PREFIX}/wishes`;
const GRANT_PATH = `${ROUTE_PREFIX}/grant`;
const MARKET_PATH = `${ROUTE_PREFIX}/market`;
const MARKET_LIST_PATH = `${MARKET_PATH}/list`;
const MARKET_CANCEL_PATH = `${MARKET_PATH}/cancel`;
const MARKET_BUY_PATH = `${MARKET_PATH}/buy`;

type WigForgeHttpMintBody = WigForgeMintInput & {
  inventoryKey?: string;
};

type WigForgeHttpEquipBody = {
  inventoryKey?: string;
  assetId?: string;
};

type WigForgeHttpGrantBody = {
  inventoryKey?: string;
  wishId?: string;
  assetId?: string;
};

type WigForgeHttpMarketListBody = {
  inventoryKey?: string;
  assetId?: string;
  priceWig?: number;
  note?: string;
};

type WigForgeHttpMarketCancelBody = {
  inventoryKey?: string;
  listingId?: string;
};

type WigForgeHttpMarketBuyBody = {
  inventoryKey?: string;
  listingId?: string;
};

export function createWigForgeHttpHandler(params: {
  config: WigForgeResolvedConfig;
  logger?: { warn?: (message: string) => void };
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed || !parsed.pathname.startsWith(ROUTE_PREFIX)) {
      return false;
    }

    const corsOrigin = resolveCorsOrigin(req.headers.origin);
    if (req.headers.origin && !corsOrigin) {
      respondJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    setCorsHeaders(res, corsOrigin);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }

    if (parsed.pathname === HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      respondJson(res, 200, { ok: true, route: "wig-forge", ready: true }, req.method === "HEAD");
      return true;
    }

    if (parsed.pathname === INVENTORY_PATH) {
      if (req.method !== "GET") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const inventoryKey = resolveInventoryKey(parsed.searchParams.get("inventoryKey"));
      const store = new WigForgeStore(
        resolveWigForgeHttpRoot(params.config, inventoryKey),
        params.config,
      );
      const inventory = await store.read();
      respondJson(res, 200, {
        ok: true,
        inventoryKey,
        roomUrl: buildRoomUrl(inventoryKey),
        inventory,
      });
      return true;
    }

    if (parsed.pathname === WISHES_PATH) {
      if (req.method === "GET") {
        const inventoryKey = resolveInventoryKey(parsed.searchParams.get("inventoryKey"));
        const store = new WigForgeStore(
          resolveWigForgeHttpRoot(params.config, inventoryKey),
          params.config,
        );
        const wishes = await store.readWishes();
        respondJson(res, 200, { ok: true, inventoryKey, wishes });
        return true;
      }

      if (req.method === "POST") {
        const bodyResult = await readJsonBodyWithLimit(req, {
          maxBytes: 128 * 1024,
          timeoutMs: 15_000,
          emptyObjectOnEmpty: false,
        });
        if (!bodyResult.ok) {
          respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
            error: bodyResult.error,
            code: bodyResult.code,
          });
          return true;
        }
        try {
          const body = (bodyResult.value ?? {}) as WigForgeWishInput & { inventoryKey?: string };
          const inventoryKey = resolveInventoryKey(
            body.inventoryKey || parsed.searchParams.get("inventoryKey"),
          );
          const store = new WigForgeStore(
            resolveWigForgeHttpRoot(params.config, inventoryKey),
            params.config,
          );
          const wish = createWigForgeWish(body);
          const wishes = await store.addWish(wish);
          respondJson(res, 200, { ok: true, inventoryKey, wish, wishes });
        } catch (error) {
          respondJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      }

      respondJson(res, 405, { error: "method not allowed" });
      return true;
    }

    if (parsed.pathname === MARKET_PATH) {
      if (req.method !== "GET") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const inventoryKey = resolveInventoryKey(parsed.searchParams.get("inventoryKey"));
      const marketStore = new WigForgeMarketStore(resolveWigForgeMarketRoot(params.config));
      const market = await marketStore.read();
      const inventory = await new WigForgeStore(
        resolveWigForgeHttpRoot(params.config, inventoryKey),
        params.config,
      ).read();
      respondJson(res, 200, buildMarketResponse({ inventoryKey, inventory, market }));
      return true;
    }

    if (parsed.pathname === MARKET_LIST_PATH) {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: 128 * 1024,
        timeoutMs: 15_000,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          error: bodyResult.error,
          code: bodyResult.code,
        });
        return true;
      }
      try {
        const body = (bodyResult.value ?? {}) as WigForgeHttpMarketListBody;
        const inventoryKey = resolveInventoryKey(body.inventoryKey);
        const result = await createMarketListing({
          config: params.config,
          input: {
            inventoryKey,
            assetId: String(body.assetId || "").trim(),
            priceWig: Number(body.priceWig),
            note: body.note,
          },
        });
        respondJson(res, 200, {
          ok: true,
          inventoryKey,
          listing: result.listing,
          ...buildMarketResponse({
            inventoryKey,
            inventory: result.inventory,
            market: result.market,
          }),
        });
      } catch (error) {
        respondJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (parsed.pathname === MARKET_CANCEL_PATH) {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: 128 * 1024,
        timeoutMs: 15_000,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          error: bodyResult.error,
          code: bodyResult.code,
        });
        return true;
      }
      try {
        const body = (bodyResult.value ?? {}) as WigForgeHttpMarketCancelBody;
        const inventoryKey = resolveInventoryKey(body.inventoryKey);
        const result = await cancelMarketListing({
          config: params.config,
          input: {
            inventoryKey,
            listingId: String(body.listingId || "").trim(),
          },
        });
        const inventory = await new WigForgeStore(
          resolveWigForgeHttpRoot(params.config, inventoryKey),
          params.config,
        ).read();
        respondJson(res, 200, {
          ok: true,
          inventoryKey,
          listing: result.listing,
          ...buildMarketResponse({
            inventoryKey,
            inventory,
            market: result.market,
          }),
        });
      } catch (error) {
        respondJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (parsed.pathname === MARKET_BUY_PATH) {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: 128 * 1024,
        timeoutMs: 15_000,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          error: bodyResult.error,
          code: bodyResult.code,
        });
        return true;
      }
      try {
        const body = (bodyResult.value ?? {}) as WigForgeHttpMarketBuyBody;
        const inventoryKey = resolveInventoryKey(body.inventoryKey);
        const result = await purchaseMarketListing({
          config: params.config,
          input: {
            inventoryKey,
            listingId: String(body.listingId || "").trim(),
          },
        });
        respondJson(res, 200, {
          ok: true,
          inventoryKey,
          listing: result.listing,
          asset: result.asset,
          inventory: result.buyerInventory,
          ...buildMarketResponse({
            inventoryKey,
            inventory: result.buyerInventory,
            market: result.market,
          }),
        });
      } catch (error) {
        respondJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (parsed.pathname === ROOM_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const inventoryKey = resolveInventoryKey(parsed.searchParams.get("inventoryKey"));
      respondHtml(
        res,
        200,
        renderWigForgeRoomPage({
          inventoryKey,
        }),
        req.method === "HEAD",
      );
      return true;
    }

    if (parsed.pathname === FILE_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const inventoryKey = resolveInventoryKey(parsed.searchParams.get("inventoryKey"));
      const assetId = String(parsed.searchParams.get("assetId") || "").trim();
      const fileKind = resolveFileKind(parsed.searchParams.get("kind"));
      if (!assetId) {
        respondJson(res, 400, { error: "assetId is required" });
        return true;
      }
      const store = new WigForgeStore(
        resolveWigForgeHttpRoot(params.config, inventoryKey),
        params.config,
      );
      const inventory = await store.read();
      const asset = inventory.assets.find((entry) => entry.id === assetId);
      if (!asset) {
        respondJson(res, 404, { error: "asset not found" });
        return true;
      }
      const filePath = resolveAssetFilePath(asset, fileKind);
      if (!filePath || !isPathInside(store.rootDir, filePath)) {
        respondJson(res, 404, { error: "asset file not found" });
        return true;
      }
      try {
        const buffer = await fs.readFile(filePath);
        respondBuffer(
          res,
          200,
          buffer,
          resolveAssetFileContentType(asset, fileKind),
          req.method === "HEAD",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          respondJson(res, 404, { error: "asset file missing on disk" });
          return true;
        }
        throw error;
      }
      return true;
    }

    if (parsed.pathname === EQUIP_PATH) {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: 128 * 1024,
        timeoutMs: 15_000,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          error: bodyResult.error,
          code: bodyResult.code,
        });
        return true;
      }
      const body = (bodyResult.value ?? {}) as WigForgeHttpEquipBody;
      try {
        const inventoryKey = resolveInventoryKey(body.inventoryKey);
        const assetId = String(body.assetId || "").trim();
        if (!assetId) {
          throw new Error("assetId is required");
        }
        const store = new WigForgeStore(
          resolveWigForgeHttpRoot(params.config, inventoryKey),
          params.config,
        );
        const { asset, inventory } = await store.equip(assetId);
        respondJson(res, 200, {
          ok: true,
          inventoryKey,
          asset,
          inventory,
        });
      } catch (error) {
        respondJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (parsed.pathname === GRANT_PATH) {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: 128 * 1024,
        timeoutMs: 15_000,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          error: bodyResult.error,
          code: bodyResult.code,
        });
        return true;
      }
      try {
        const body = (bodyResult.value ?? {}) as WigForgeHttpGrantBody;
        const inventoryKey = resolveInventoryKey(body.inventoryKey);
        const wishId = String(body.wishId || "").trim();
        const assetId = String(body.assetId || "").trim();
        if (!wishId) {
          throw new Error("wishId is required");
        }
        if (!assetId) {
          throw new Error("assetId is required");
        }
        const store = new WigForgeStore(
          resolveWigForgeHttpRoot(params.config, inventoryKey),
          params.config,
        );
        const result = await store.grantWish(wishId, assetId);
        respondJson(res, 200, {
          ok: true,
          inventoryKey,
          wish: result.wish,
          asset: result.asset,
          wishes: result.wishes,
          inventory: result.inventory,
        });
      } catch (error) {
        respondJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (parsed.pathname === FORGE_PATH) {
      if (req.method !== "POST") {
        respondJson(res, 405, { error: "method not allowed" });
        return true;
      }

      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: params.config.maxSourceBytes + 256 * 1024,
        timeoutMs: 30_000,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          error: bodyResult.error,
          code: bodyResult.code,
        });
        return true;
      }

      const body = (bodyResult.value ?? {}) as WigForgeHttpMintBody;
      try {
        const inventoryKey = resolveInventoryKey(body.inventoryKey);
        const store = new WigForgeStore(
          resolveWigForgeHttpRoot(params.config, inventoryKey),
          params.config,
        );
        const asset = await mintForgeAsset({
          toolCallId: `http-${Date.now()}`,
          input: body,
          config: params.config,
          store,
          agentId: inventoryKey,
        });
        const inventory = await store.addAsset(asset);
        respondJson(res, 200, {
          ok: true,
          inventoryKey,
          roomUrl: buildRoomUrl(inventoryKey),
          asset,
          inventory,
        });
      } catch (error) {
        params.logger?.warn?.(`wig-forge http forge failed: ${String(error)}`);
        respondJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    return false;
  };
}

function buildRoomUrl(inventoryKey: string): string {
  return `${ROOM_PATH}?inventoryKey=${encodeURIComponent(inventoryKey)}`;
}

function buildMarketResponse(params: {
  inventoryKey: string;
  inventory: Awaited<ReturnType<WigForgeStore["read"]>>;
  market: Awaited<ReturnType<WigForgeMarketStore["read"]>>;
}) {
  const summary = summarizeMarketDocument({
    inventoryKey: params.inventoryKey,
    market: params.market,
  });
  return {
    market: params.market,
    activeListings: summary.activeListings,
    ownListings: summary.ownListings,
    recentSales: summary.recentSales,
    wallet: params.inventory.wallet,
  };
}

function resolveInventoryKey(input?: string | null): string {
  return typeof input === "string" && input.trim() ? input.trim() : "default-web";
}

function resolveFileKind(input?: string | null): "preview" | "sprite" | "source" | "vector" {
  if (input === "source" || input === "sprite" || input === "vector") {
    return input;
  }
  return "preview";
}

function resolveAssetFilePath(
  asset: WigForgeAsset,
  kind: "preview" | "sprite" | "source" | "vector",
): string | undefined {
  if (kind === "source") {
    return asset.files.sourcePath;
  }
  if (kind === "vector") {
    return asset.files.svgPath;
  }
  if (kind === "sprite") {
    return asset.files.spritePath;
  }
  return asset.files.previewPath || asset.files.spritePath || asset.files.sourcePath;
}

function resolveAssetFileContentType(
  asset: WigForgeAsset,
  kind: "preview" | "sprite" | "source" | "vector",
): string {
  if (kind === "source") {
    return (
      asset.files.mimeType ||
      inferMimeFromPath(asset.files.sourcePath) ||
      "application/octet-stream"
    );
  }
  if (kind === "vector") {
    return "image/svg+xml";
  }
  return "image/png";
}

function inferMimeFromPath(filePath?: string): string | undefined {
  const extension = path.extname(filePath || "").toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  return undefined;
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function resolveCorsOrigin(originHeader?: string | string[]): string | undefined {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) {
    return undefined;
  }
  if (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://")
  ) {
    return origin;
  }
  try {
    const parsed = new URL(origin);
    if (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]"
    ) {
      return origin;
    }
  } catch {}
  return undefined;
}

function setCorsHeaders(res: ServerResponse, origin?: string): void {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Wig-Forge-Client");
}

function respondHtml(
  res: ServerResponse,
  statusCode: number,
  body: string,
  skipBody = false,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (skipBody) {
    res.end();
    return;
  }
  res.end(body);
}

function respondBuffer(
  res: ServerResponse,
  statusCode: number,
  body: Buffer,
  contentType: string,
  skipBody = false,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=60");
  if (skipBody) {
    res.end();
    return;
  }
  res.end(body);
}

function respondJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  skipBody = false,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (skipBody) {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}
