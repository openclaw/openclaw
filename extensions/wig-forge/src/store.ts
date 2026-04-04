import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../../../src/infra/json-files.js";
import type { OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import type { WigForgeResolvedConfig } from "./config.js";
import { WigForgeR2Sync } from "./r2.js";
import {
  WIG_FORGE_SLOTS,
  type WigForgeAsset,
  type WigForgeInventoryDocument,
  type WigForgeMarketDocument,
  type WigForgeMarketListing,
  type WigForgeWallet,
  type WigForgeWish,
  type WigForgeWishDocument,
} from "./types.js";

export const WIG_FORGE_STARTER_WIG_BALANCE = 240;

function createEmptyWallet(): WigForgeWallet {
  return {
    wigBalance: WIG_FORGE_STARTER_WIG_BALANCE,
    starterGrant: WIG_FORGE_STARTER_WIG_BALANCE,
    earnedFromSales: 0,
    spentOnPurchases: 0,
  };
}

function createEmptyInventory(): WigForgeInventoryDocument {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    assets: [],
    loadout: {
      head: null,
      face: null,
      body: null,
      neck: null,
      companion: null,
      aura: null,
    },
    wallet: createEmptyWallet(),
  };
}

function createEmptyWishDocument(): WigForgeWishDocument {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    wishes: [],
  };
}

function createEmptyMarketDocument(): WigForgeMarketDocument {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    listings: [],
  };
}

export function sanitizeWigForgeInventorySegment(input?: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "default").slice(0, 80);
}

export function resolveSharedWigForgeRoot(baseDir: string, inventoryKey?: string): string {
  return path.join(baseDir, sanitizeWigForgeInventorySegment(inventoryKey));
}

export function resolveWigForgeRoot(
  ctx: OpenClawPluginToolContext,
  config: WigForgeResolvedConfig,
): string {
  if (config.storageDir) {
    return resolveSharedWigForgeRoot(config.storageDir, ctx.agentId || "default-agent");
  }
  if (ctx.workspaceDir) {
    return path.join(ctx.workspaceDir, ".openclaw", "wig-forge");
  }
  const agentSegment = ctx.agentId?.trim() || "anonymous-agent";
  return path.join(os.tmpdir(), "openclaw-wig-forge", agentSegment);
}

export function resolveWigForgeHttpRoot(
  config: WigForgeResolvedConfig,
  inventoryKey?: string,
): string {
  if (config.storageDir) {
    return resolveSharedWigForgeRoot(config.storageDir, inventoryKey || "default-web");
  }
  return path.join(
    os.tmpdir(),
    "openclaw-wig-forge-http",
    sanitizeWigForgeInventorySegment(inventoryKey || "default-web"),
  );
}

export function resolveWigForgeMarketRoot(config: WigForgeResolvedConfig): string {
  if (config.storageDir) {
    return path.join(config.storageDir, "_market");
  }
  return path.join(os.tmpdir(), "openclaw-wig-forge-market");
}

export class WigForgeStore {
  private readonly r2Sync?: WigForgeR2Sync;

  constructor(
    readonly rootDir: string,
    readonly config?: WigForgeResolvedConfig,
  ) {
    this.r2Sync = config?.r2 ? new WigForgeR2Sync(config.r2) : undefined;
  }

  private get inventoryPath(): string {
    return path.join(this.rootDir, "inventory.json");
  }

  private get assetsDir(): string {
    return path.join(this.rootDir, "assets");
  }

  private get wishesPath(): string {
    return path.join(this.rootDir, "wishes.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.assetsDir, { recursive: true });
  }

  async read(): Promise<WigForgeInventoryDocument> {
    await this.init();
    try {
      const raw = await fs.readFile(this.inventoryPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WigForgeInventoryDocument>;
      return {
        ...createEmptyInventory(),
        ...parsed,
        assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        loadout: {
          ...createEmptyInventory().loadout,
          ...(parsed.loadout ?? {}),
        },
        wallet: {
          ...createEmptyWallet(),
          ...(parsed.wallet ?? {}),
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyInventory();
      }
      throw err;
    }
  }

  async write(doc: WigForgeInventoryDocument): Promise<void> {
    await this.init();
    await writeJsonAtomic(this.inventoryPath, {
      ...doc,
      updatedAt: new Date().toISOString(),
    });
  }

  async readWishes(): Promise<WigForgeWishDocument> {
    await this.init();
    try {
      const raw = await fs.readFile(this.wishesPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WigForgeWishDocument>;
      return {
        ...createEmptyWishDocument(),
        ...parsed,
        wishes: Array.isArray(parsed.wishes) ? parsed.wishes : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyWishDocument();
      }
      throw err;
    }
  }

  async writeWishes(doc: WigForgeWishDocument): Promise<void> {
    await this.init();
    await writeJsonAtomic(this.wishesPath, {
      ...doc,
      updatedAt: new Date().toISOString(),
    });
  }

  async countByFingerprint(sourceFingerprint: string): Promise<number> {
    const doc = await this.read();
    return doc.assets.filter((asset) => asset.sourceFingerprint === sourceFingerprint).length;
  }

  async saveAssetFiles(params: {
    assetId: string;
    sourceBuffer?: Buffer;
    sourceExt?: string;
    spriteBuffer?: Buffer;
    previewBuffer?: Buffer;
    svgText?: string;
  }): Promise<{
    sourcePath?: string;
    spritePath?: string;
    previewPath?: string;
    svgPath?: string;
    sourceUrl?: string;
    spriteUrl?: string;
    previewUrl?: string;
    svgUrl?: string;
  }> {
    await this.init();
    const assetDir = path.join(this.assetsDir, params.assetId);
    await fs.mkdir(assetDir, { recursive: true });

    let sourcePath: string | undefined;
    if (params.sourceBuffer) {
      sourcePath = path.join(assetDir, `source${params.sourceExt || ".bin"}`);
      await fs.writeFile(sourcePath, params.sourceBuffer);
    }

    let spritePath: string | undefined;
    if (params.spriteBuffer) {
      spritePath = path.join(assetDir, "sprite.png");
      await fs.writeFile(spritePath, params.spriteBuffer);
    }

    let previewPath: string | undefined;
    if (params.previewBuffer) {
      previewPath = path.join(assetDir, "preview.png");
      await fs.writeFile(previewPath, params.previewBuffer);
    }

    let svgPath: string | undefined;
    if (typeof params.svgText === "string" && params.svgText.trim()) {
      svgPath = path.join(assetDir, "vector.svg");
      await fs.writeFile(svgPath, params.svgText, "utf8");
    }

    let sourceUrl: string | undefined;
    let spriteUrl: string | undefined;
    let previewUrl: string | undefined;
    let svgUrl: string | undefined;

    if (this.r2Sync) {
      if (params.sourceBuffer) {
        sourceUrl = (
          await this.r2Sync.uploadObject({
            assetId: params.assetId,
            fileName: `source${params.sourceExt || ".bin"}`,
            body: params.sourceBuffer,
            contentType:
              inferContentTypeFromExtension(params.sourceExt) || "application/octet-stream",
          })
        ).url;
      }
      if (params.spriteBuffer) {
        spriteUrl = (
          await this.r2Sync.uploadObject({
            assetId: params.assetId,
            fileName: "sprite.png",
            body: params.spriteBuffer,
            contentType: "image/png",
          })
        ).url;
      }
      if (params.previewBuffer) {
        previewUrl = (
          await this.r2Sync.uploadObject({
            assetId: params.assetId,
            fileName: "preview.png",
            body: params.previewBuffer,
            contentType: "image/png",
          })
        ).url;
      }
      if (typeof params.svgText === "string" && params.svgText.trim()) {
        svgUrl = (
          await this.r2Sync.uploadObject({
            assetId: params.assetId,
            fileName: "vector.svg",
            body: params.svgText,
            contentType: "image/svg+xml; charset=utf-8",
          })
        ).url;
      }
    }

    return {
      sourcePath,
      spritePath,
      previewPath,
      svgPath,
      sourceUrl,
      spriteUrl,
      previewUrl,
      svgUrl,
    };
  }

  async addAsset(asset: WigForgeAsset): Promise<WigForgeInventoryDocument> {
    const doc = await this.read();
    doc.assets.push(asset);
    await this.write(doc);
    return doc;
  }

  async addWish(wish: WigForgeWish): Promise<WigForgeWishDocument> {
    const doc = await this.readWishes();
    doc.wishes.push(wish);
    await this.writeWishes(doc);
    return doc;
  }

  resolveAssetDir(assetId: string): string {
    return path.join(this.assetsDir, assetId);
  }

  async adjustWallet(params: {
    wigDelta?: number;
    earnedDelta?: number;
    spentDelta?: number;
  }): Promise<WigForgeInventoryDocument> {
    const doc = await this.read();
    doc.wallet.wigBalance = Math.max(0, Math.round(doc.wallet.wigBalance + (params.wigDelta ?? 0)));
    doc.wallet.earnedFromSales = Math.max(
      0,
      Math.round(doc.wallet.earnedFromSales + (params.earnedDelta ?? 0)),
    );
    doc.wallet.spentOnPurchases = Math.max(
      0,
      Math.round(doc.wallet.spentOnPurchases + (params.spentDelta ?? 0)),
    );
    await this.write(doc);
    return doc;
  }

  async transferAssetTo(params: {
    assetId: string;
    targetStore: WigForgeStore;
    nextOwnerId?: string;
  }): Promise<{
    asset: WigForgeAsset;
    sourceInventory: WigForgeInventoryDocument;
    targetInventory: WigForgeInventoryDocument;
  }> {
    const sourceDoc = await this.read();
    const assetIndex = sourceDoc.assets.findIndex((entry) => entry.id === params.assetId);
    if (assetIndex < 0) {
      throw new Error(`asset not found: ${params.assetId}`);
    }

    const [asset] = sourceDoc.assets.splice(assetIndex, 1);
    for (const slot of WIG_FORGE_SLOTS) {
      if (sourceDoc.loadout[slot] === asset.id) {
        sourceDoc.loadout[slot] = null;
      }
    }

    await params.targetStore.init();
    const targetDoc = await params.targetStore.read();
    if (targetDoc.assets.some((entry) => entry.id === asset.id)) {
      throw new Error(`asset already exists in target inventory: ${asset.id}`);
    }

    const sourceAssetDir = this.resolveAssetDir(asset.id);
    const targetAssetDir = params.targetStore.resolveAssetDir(asset.id);
    await moveDirectoryIfPresent(sourceAssetDir, targetAssetDir);

    const movedAsset: WigForgeAsset = {
      ...asset,
      ownerAgentId: params.nextOwnerId ?? asset.ownerAgentId,
      files: rebaseAssetFiles(asset.files, targetAssetDir),
    };

    targetDoc.assets.push(movedAsset);
    await this.write(sourceDoc);
    await params.targetStore.write(targetDoc);

    return {
      asset: movedAsset,
      sourceInventory: sourceDoc,
      targetInventory: targetDoc,
    };
  }

  async grantWish(
    wishId: string,
    assetId: string,
  ): Promise<{
    wish: WigForgeWish;
    asset: WigForgeAsset;
    wishes: WigForgeWishDocument;
    inventory: WigForgeInventoryDocument;
  }> {
    const wishes = await this.readWishes();
    const wish = wishes.wishes.find((entry) => entry.id === wishId);
    if (!wish) {
      throw new Error(`wish not found: ${wishId}`);
    }
    if (wish.status === "granted") {
      throw new Error(`wish already granted: ${wishId}`);
    }
    const inventory = await this.read();
    const asset = inventory.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      throw new Error(`asset not found: ${assetId}`);
    }
    if (asset.slot !== wish.slot) {
      throw new Error(`asset slot ${asset.slot} does not match wish slot ${wish.slot}`);
    }

    wish.status = "granted";
    wish.grantedAt = new Date().toISOString();
    wish.grantedAssetId = asset.id;
    inventory.loadout[asset.slot] = asset.id;
    await this.write(inventory);
    await this.writeWishes(wishes);

    return { wish, asset, wishes, inventory };
  }

  async equip(
    assetId: string,
  ): Promise<{ asset: WigForgeAsset; inventory: WigForgeInventoryDocument }> {
    const doc = await this.read();
    const asset = doc.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      throw new Error(`asset not found: ${assetId}`);
    }
    for (const slot of WIG_FORGE_SLOTS) {
      if (slot === asset.slot) {
        doc.loadout[slot] = asset.id;
      }
    }
    await this.write(doc);
    return { asset, inventory: doc };
  }
}

export class WigForgeMarketStore {
  constructor(readonly rootDir: string) {}

  private get marketPath(): string {
    return path.join(this.rootDir, "market.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async read(): Promise<WigForgeMarketDocument> {
    await this.init();
    try {
      const raw = await fs.readFile(this.marketPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WigForgeMarketDocument>;
      return {
        ...createEmptyMarketDocument(),
        ...parsed,
        listings: Array.isArray(parsed.listings) ? parsed.listings : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyMarketDocument();
      }
      throw err;
    }
  }

  async write(doc: WigForgeMarketDocument): Promise<void> {
    await this.init();
    await writeJsonAtomic(this.marketPath, {
      ...doc,
      updatedAt: new Date().toISOString(),
    });
  }

  async addListing(listing: WigForgeMarketListing): Promise<WigForgeMarketDocument> {
    const doc = await this.read();
    doc.listings.push(listing);
    await this.write(doc);
    return doc;
  }
}

function rebaseAssetFiles(files: WigForgeAsset["files"], assetDir: string): WigForgeAsset["files"] {
  return {
    ...files,
    sourcePath: files.sourcePath ? path.join(assetDir, path.basename(files.sourcePath)) : undefined,
    spritePath: files.spritePath ? path.join(assetDir, path.basename(files.spritePath)) : undefined,
    previewPath: files.previewPath
      ? path.join(assetDir, path.basename(files.previewPath))
      : undefined,
    svgPath: files.svgPath ? path.join(assetDir, path.basename(files.svgPath)) : undefined,
  };
}

function inferContentTypeFromExtension(extension?: string): string | undefined {
  const normalized = String(extension || "")
    .trim()
    .toLowerCase();
  if (normalized === ".png") {
    return "image/png";
  }
  if (normalized === ".jpg" || normalized === ".jpeg") {
    return "image/jpeg";
  }
  if (normalized === ".webp") {
    return "image/webp";
  }
  if (normalized === ".gif") {
    return "image/gif";
  }
  if (normalized === ".svg") {
    return "image/svg+xml";
  }
  return undefined;
}

async function moveDirectoryIfPresent(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  try {
    await fs.rename(sourceDir, targetDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    if (code !== "EXDEV") {
      throw error;
    }
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  }
}
