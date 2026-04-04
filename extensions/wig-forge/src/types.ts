export const WIG_FORGE_SLOTS = ["head", "face", "body", "neck", "companion", "aura"] as const;

export const WIG_FORGE_RARITIES = ["common", "uncommon", "rare", "epic", "mythic"] as const;

export const WIG_FORGE_WISH_STATUSES = ["active", "granted"] as const;
export const WIG_FORGE_MARKET_STATUSES = ["active", "sold", "cancelled"] as const;

export type WigForgeSlot = (typeof WIG_FORGE_SLOTS)[number];
export type WigForgeRarity = (typeof WIG_FORGE_RARITIES)[number];
export type WigForgeWishStatus = (typeof WIG_FORGE_WISH_STATUSES)[number];
export type WigForgeMarketStatus = (typeof WIG_FORGE_MARKET_STATUSES)[number];

export type WigForgeScoreBreakdown = {
  novelty: number;
  duplicatePenalty: number;
  effectiveNovelty: number;
  maskQuality: number;
  taskQuality: number;
  styleFit: number;
  luck: number;
  finalScore: number;
};

export type WigForgeVisualVariant = {
  material: string;
  trim: string;
  fxPreset: string;
  hueShift: number;
  saturationBoost: number;
  brightnessBoost: number;
  accentColor: string;
};

export type WigForgeAssetContourPoint = {
  x: number;
  y: number;
};

export type WigForgeAssetAnchorPoint = {
  x: number;
  y: number;
  confidence: number;
};

export type WigForgeAssetAssemblyMount = {
  translateX: number;
  translateY: number;
  scale: number;
  rotate: number;
  originX: number;
  originY: number;
};

export type WigForgeAssetAssemblyProfile = {
  contentBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  centroid: {
    x: number;
    y: number;
  };
  pivot: WigForgeAssetAnchorPoint;
  contour: WigForgeAssetContourPoint[];
  mount: WigForgeAssetAssemblyMount;
};

export type WigForgeAssetFiles = {
  sourcePath?: string;
  spritePath?: string;
  previewPath?: string;
  svgPath?: string;
  sourceUrl?: string;
  spriteUrl?: string;
  previewUrl?: string;
  svgUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

export type WigForgeAsset = {
  id: string;
  ownerAgentId?: string;
  name: string;
  slot: WigForgeSlot;
  rarity: WigForgeRarity;
  originUrl?: string;
  sourceFingerprint: string;
  variantSeed: string;
  styleTags: string[];
  palette: string[];
  files: WigForgeAssetFiles;
  visuals: WigForgeVisualVariant;
  assembly?: WigForgeAssetAssemblyProfile;
  score: WigForgeScoreBreakdown;
  createdAt: string;
};

export type WigForgeWallet = {
  wigBalance: number;
  starterGrant: number;
  earnedFromSales: number;
  spentOnPurchases: number;
};

export type WigForgeLoadout = Record<WigForgeSlot, string | null>;

export type WigForgeInventoryDocument = {
  version: 1;
  updatedAt: string;
  assets: WigForgeAsset[];
  loadout: WigForgeLoadout;
  wallet: WigForgeWallet;
};

export type WigForgeWish = {
  id: string;
  title: string;
  slot: WigForgeSlot;
  desiredRarity?: WigForgeRarity;
  styleTags: string[];
  note?: string;
  requestedBy?: string;
  status: WigForgeWishStatus;
  createdAt: string;
  grantedAt?: string;
  grantedAssetId?: string;
};

export type WigForgeWishDocument = {
  version: 1;
  updatedAt: string;
  wishes: WigForgeWish[];
};

export type WigForgeMarketListingAssetSnapshot = {
  name: string;
  slot: WigForgeSlot;
  rarity: WigForgeRarity;
  palette: string[];
  files?: Pick<WigForgeAssetFiles, "sourceUrl" | "spriteUrl" | "previewUrl" | "svgUrl">;
  visuals: WigForgeVisualVariant;
  createdAt: string;
};

export type WigForgeMarketListing = {
  id: string;
  assetId: string;
  sellerInventoryKey: string;
  priceWig: number;
  note?: string;
  status: WigForgeMarketStatus;
  createdAt: string;
  cancelledAt?: string;
  soldAt?: string;
  soldToInventoryKey?: string;
  assetSnapshot: WigForgeMarketListingAssetSnapshot;
};

export type WigForgeMarketDocument = {
  version: 1;
  updatedAt: string;
  listings: WigForgeMarketListing[];
};
