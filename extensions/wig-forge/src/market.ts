import type { WigForgeResolvedConfig } from "./config.js";
import { hashHex } from "./random.js";
import {
  WigForgeMarketStore,
  WigForgeStore,
  resolveWigForgeHttpRoot,
  resolveWigForgeMarketRoot,
} from "./store.js";
import type { WigForgeAsset, WigForgeMarketDocument, WigForgeMarketListing } from "./types.js";

export type WigForgeCreateListingInput = {
  inventoryKey: string;
  assetId: string;
  priceWig: number;
  note?: string;
};

export type WigForgeCancelListingInput = {
  inventoryKey: string;
  listingId: string;
};

export type WigForgePurchaseListingInput = {
  inventoryKey: string;
  listingId: string;
};

export async function createMarketListing(params: {
  config: WigForgeResolvedConfig;
  input: WigForgeCreateListingInput;
}): Promise<{
  listing: WigForgeMarketListing;
  market: WigForgeMarketDocument;
  inventory: Awaited<ReturnType<WigForgeStore["read"]>>;
}> {
  const inventoryKey = sanitizeInventoryKey(params.input.inventoryKey);
  const assetId = String(params.input.assetId || "").trim();
  const priceWig = sanitizePrice(params.input.priceWig);
  if (!assetId) {
    throw new Error("assetId is required");
  }

  const sellerStore = new WigForgeStore(
    resolveWigForgeHttpRoot(params.config, inventoryKey),
    params.config,
  );
  const inventory = await sellerStore.read();
  const asset = inventory.assets.find((entry) => entry.id === assetId);
  if (!asset) {
    throw new Error(`asset not found: ${assetId}`);
  }

  const marketStore = new WigForgeMarketStore(resolveWigForgeMarketRoot(params.config));
  const market = await marketStore.read();
  const existing = market.listings.find(
    (entry) =>
      entry.status === "active" &&
      entry.assetId === assetId &&
      entry.sellerInventoryKey === inventoryKey,
  );
  if (existing) {
    throw new Error(`asset already listed: ${assetId}`);
  }

  const listing = buildListing({
    asset,
    sellerInventoryKey: inventoryKey,
    priceWig,
    note: sanitizeListingNote(params.input.note),
  });
  market.listings.push(listing);
  await marketStore.write(market);

  return { listing, market, inventory };
}

export async function cancelMarketListing(params: {
  config: WigForgeResolvedConfig;
  input: WigForgeCancelListingInput;
}): Promise<{
  listing: WigForgeMarketListing;
  market: WigForgeMarketDocument;
}> {
  const inventoryKey = sanitizeInventoryKey(params.input.inventoryKey);
  const listingId = String(params.input.listingId || "").trim();
  if (!listingId) {
    throw new Error("listingId is required");
  }

  const marketStore = new WigForgeMarketStore(resolveWigForgeMarketRoot(params.config));
  const market = await marketStore.read();
  const listing = market.listings.find((entry) => entry.id === listingId);
  if (!listing) {
    throw new Error(`listing not found: ${listingId}`);
  }
  if (listing.status !== "active") {
    throw new Error(`listing is not active: ${listingId}`);
  }
  if (listing.sellerInventoryKey !== inventoryKey) {
    throw new Error("only the seller can cancel this listing");
  }

  listing.status = "cancelled";
  listing.cancelledAt = new Date().toISOString();
  await marketStore.write(market);
  return { listing, market };
}

export async function purchaseMarketListing(params: {
  config: WigForgeResolvedConfig;
  input: WigForgePurchaseListingInput;
}): Promise<{
  listing: WigForgeMarketListing;
  market: WigForgeMarketDocument;
  asset: WigForgeAsset;
  buyerInventory: Awaited<ReturnType<WigForgeStore["read"]>>;
  sellerInventory: Awaited<ReturnType<WigForgeStore["read"]>>;
}> {
  const buyerInventoryKey = sanitizeInventoryKey(params.input.inventoryKey);
  const listingId = String(params.input.listingId || "").trim();
  if (!listingId) {
    throw new Error("listingId is required");
  }

  const marketStore = new WigForgeMarketStore(resolveWigForgeMarketRoot(params.config));
  const market = await marketStore.read();
  const listing = market.listings.find((entry) => entry.id === listingId);
  if (!listing) {
    throw new Error(`listing not found: ${listingId}`);
  }
  if (listing.status !== "active") {
    throw new Error(`listing is not active: ${listingId}`);
  }
  if (listing.sellerInventoryKey === buyerInventoryKey) {
    throw new Error("seller cannot buy their own listing");
  }

  const buyerStore = new WigForgeStore(
    resolveWigForgeHttpRoot(params.config, buyerInventoryKey),
    params.config,
  );
  const sellerStore = new WigForgeStore(
    resolveWigForgeHttpRoot(params.config, listing.sellerInventoryKey),
    params.config,
  );

  const buyerInventoryBefore = await buyerStore.read();
  if (buyerInventoryBefore.wallet.wigBalance < listing.priceWig) {
    throw new Error(
      `not enough wig: need ${listing.priceWig}, have ${buyerInventoryBefore.wallet.wigBalance}`,
    );
  }

  const transfer = await sellerStore.transferAssetTo({
    assetId: listing.assetId,
    targetStore: buyerStore,
    nextOwnerId: buyerInventoryKey,
  });
  const buyerInventory = await buyerStore.adjustWallet({
    wigDelta: -listing.priceWig,
    spentDelta: listing.priceWig,
  });
  const sellerInventory = await sellerStore.adjustWallet({
    wigDelta: listing.priceWig,
    earnedDelta: listing.priceWig,
  });

  listing.status = "sold";
  listing.soldAt = new Date().toISOString();
  listing.soldToInventoryKey = buyerInventoryKey;
  await marketStore.write(market);

  return {
    listing,
    market,
    asset: transfer.asset,
    buyerInventory,
    sellerInventory,
  };
}

export function summarizeMarketDocument(params: {
  market: WigForgeMarketDocument;
  inventoryKey: string;
}) {
  const activeListings = params.market.listings
    .filter((entry) => entry.status === "active")
    .sort((left, right) =>
      String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
    );
  const ownListings = activeListings.filter(
    (entry) => entry.sellerInventoryKey === sanitizeInventoryKey(params.inventoryKey),
  );
  const recentSales = params.market.listings
    .filter((entry) => entry.status === "sold")
    .sort((left, right) => String(right.soldAt || "").localeCompare(String(left.soldAt || "")))
    .slice(0, 8);
  return {
    activeListings,
    ownListings,
    recentSales,
  };
}

function buildListing(params: {
  asset: WigForgeAsset;
  sellerInventoryKey: string;
  priceWig: number;
  note?: string;
}): WigForgeMarketListing {
  const createdAt = new Date().toISOString();
  return {
    id: `wig_listing_${hashHex(`${createdAt}:${params.asset.id}:${params.sellerInventoryKey}`).slice(0, 12)}`,
    assetId: params.asset.id,
    sellerInventoryKey: params.sellerInventoryKey,
    priceWig: params.priceWig,
    note: params.note,
    status: "active",
    createdAt,
    assetSnapshot: {
      name: params.asset.name,
      slot: params.asset.slot,
      rarity: params.asset.rarity,
      palette: Array.isArray(params.asset.palette) ? [...params.asset.palette] : [],
      files: {
        sourceUrl: params.asset.files?.sourceUrl,
        spriteUrl: params.asset.files?.spriteUrl,
        previewUrl: params.asset.files?.previewUrl,
        svgUrl: params.asset.files?.svgUrl,
      },
      visuals: params.asset.visuals,
      createdAt: params.asset.createdAt,
    },
  };
}

function sanitizeInventoryKey(value: string): string {
  return String(value || "").trim() || "default-web";
}

function sanitizePrice(value: number): number {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount) || amount < 1) {
    throw new Error("priceWig must be a positive integer");
  }
  if (amount > 50_000) {
    throw new Error("priceWig is too large");
  }
  return amount;
}

function sanitizeListingNote(value?: string): string | undefined {
  const note = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return note ? note.slice(0, 180) : undefined;
}
