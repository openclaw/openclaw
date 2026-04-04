import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import type { WigForgeResolvedConfig } from "./config.js";
import { mintForgeAsset, type WigForgeMintInput } from "./forge.js";
import {
  cancelMarketListing,
  createMarketListing,
  purchaseMarketListing,
  summarizeMarketDocument,
} from "./market.js";
import {
  WigForgeMarketStore,
  WigForgeStore,
  resolveWigForgeMarketRoot,
  resolveWigForgeRoot,
} from "./store.js";
import { WIG_FORGE_RARITIES, WIG_FORGE_SLOTS } from "./types.js";
import { createWigForgeWish, type WigForgeWishInput } from "./wishes.js";

const SlotLiteralSchema = Type.Union([
  Type.Literal("auto"),
  ...WIG_FORGE_SLOTS.map((slot) => Type.Literal(slot)),
]);

const MintSchema = Type.Object(
  {
    sourceDataUrl: Type.Optional(Type.String({ minLength: 8 })),
    sourceBase64: Type.Optional(Type.String({ minLength: 8 })),
    mimeType: Type.Optional(Type.String({ minLength: 3 })),
    originUrl: Type.Optional(Type.String({ minLength: 1 })),
    slotHint: Type.Optional(SlotLiteralSchema),
    nameHint: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    styleTags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 12 }),
    ),
    taskQuality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    maskQuality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    novelty: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    styleFit: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    luck: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  {
    additionalProperties: false,
    description:
      "Forge a wearable asset from a captured image payload. Use sourceDataUrl when possible so mime is preserved.",
  },
);

const EquipSchema = Type.Object(
  {
    assetId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const DesiredRaritySchema = Type.Union([
  Type.Literal("any"),
  ...WIG_FORGE_RARITIES.map((rarity) => Type.Literal(rarity)),
]);

const WishCreateSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80 }),
    slot: Type.Union(WIG_FORGE_SLOTS.map((slot) => Type.Literal(slot))),
    desiredRarity: Type.Optional(DesiredRaritySchema),
    styleTags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 }),
    ),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 220 })),
    requestedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  },
  { additionalProperties: false },
);

const WishGrantSchema = Type.Object(
  {
    wishId: Type.String({ minLength: 1 }),
    assetId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const MarketOfferSchema = Type.Object(
  {
    assetId: Type.String({ minLength: 1 }),
    priceWig: Type.Integer({ minimum: 1, maximum: 50_000 }),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
  },
  { additionalProperties: false },
);

const MarketCancelSchema = Type.Object(
  {
    listingId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const MarketBuySchema = Type.Object(
  {
    listingId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

function formatAssetSummary(
  prefix: string,
  asset: {
    id: string;
    name: string;
    rarity: string;
    slot: string;
  },
): string {
  return `${prefix}: ${asset.name} (${asset.rarity}, ${asset.slot}) [${asset.id}]`;
}

function textResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createWigForgeTools(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  config: WigForgeResolvedConfig;
}): AnyAgentTool[] {
  const store = new WigForgeStore(resolveWigForgeRoot(params.ctx, params.config), params.config);

  const mintTool: AnyAgentTool = {
    name: "wig_forge_mint",
    label: "Wig Forge Mint",
    description:
      "Mint a wearable asset from a captured web image and store it in the current bot inventory.",
    parameters: MintSchema,
    async execute(toolCallId, rawParams) {
      const input = rawParams as WigForgeMintInput;
      const asset = await mintForgeAsset({
        toolCallId,
        input,
        config: params.config,
        store,
        agentId: params.ctx.agentId,
      });
      const inventory = await store.addAsset(asset);
      return textResult(
        `${formatAssetSummary("Forged asset", asset)}\nStored under ${asset.files.spritePath ?? "workspace inventory"}.\nInventory size: ${inventory.assets.length}.`,
        { asset, inventory },
      );
    },
  };

  const listTool: AnyAgentTool = {
    name: "wig_inventory_list",
    label: "Wig Inventory List",
    description:
      "List forged wearable assets and the current equip loadout for this bot workspace.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const inventory = await store.read();
      const equipped = Object.entries(inventory.loadout)
        .filter(([, assetId]) => Boolean(assetId))
        .map(([slot, assetId]) => `${slot}: ${assetId}`)
        .join(", ");
      return textResult(
        `Inventory contains ${inventory.assets.length} asset(s). Wig balance: ${inventory.wallet?.wigBalance ?? 0}.${equipped ? ` Equipped -> ${equipped}` : " Nothing equipped yet."}`,
        { inventory },
      );
    },
  };

  const equipTool: AnyAgentTool = {
    name: "wig_inventory_equip",
    label: "Wig Inventory Equip",
    description: "Equip a forged asset into its matching slot.",
    parameters: EquipSchema,
    async execute(_toolCallId, rawParams) {
      const assetId = String((rawParams as { assetId?: string }).assetId || "").trim();
      if (!assetId) {
        throw new Error("assetId is required");
      }
      const { asset, inventory } = await store.equip(assetId);
      return textResult(
        `${formatAssetSummary("Equipped asset", asset)}\nLoadout slot ${asset.slot} now points to ${asset.id}.`,
        { asset, inventory },
      );
    },
  };

  const wishCreateTool: AnyAgentTool = {
    name: "wig_wish_create",
    label: "Wig Wish Create",
    description:
      "Record a specific wearable wish for the current bot inventory so humans can grant it later.",
    parameters: WishCreateSchema,
    async execute(_toolCallId, rawParams) {
      const wish = createWigForgeWish(rawParams as WigForgeWishInput);
      const wishes = await store.addWish(wish);
      return textResult(
        `Recorded wish: ${wish.title} (${wish.slot}${wish.desiredRarity ? `, aiming for ${wish.desiredRarity}` : ""}). Active wishes: ${wishes.wishes.filter((entry) => entry.status === "active").length}.`,
        { wish, wishes },
      );
    },
  };

  const wishListTool: AnyAgentTool = {
    name: "wig_wish_list",
    label: "Wig Wish List",
    description: "List active and granted wishes for the current bot inventory.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const wishes = await store.readWishes();
      const active = wishes.wishes.filter((entry) => entry.status === "active");
      const granted = wishes.wishes.filter((entry) => entry.status === "granted");
      return textResult(`Wishes: ${active.length} active, ${granted.length} granted.`, {
        wishes,
        active,
        granted,
      });
    },
  };

  const wishGrantTool: AnyAgentTool = {
    name: "wig_wish_grant",
    label: "Wig Wish Grant",
    description: "Grant one wish by attaching a matching owned asset and equipping it for the bot.",
    parameters: WishGrantSchema,
    async execute(_toolCallId, rawParams) {
      const wishId = String((rawParams as { wishId?: string }).wishId || "").trim();
      const assetId = String((rawParams as { assetId?: string }).assetId || "").trim();
      if (!wishId) {
        throw new Error("wishId is required");
      }
      if (!assetId) {
        throw new Error("assetId is required");
      }
      const result = await store.grantWish(wishId, assetId);
      return textResult(
        `Granted wish: ${result.wish.title} with ${result.asset.name}. Slot ${result.asset.slot} is now equipped.`,
        result,
      );
    },
  };

  const marketListTool: AnyAgentTool = {
    name: "wig_market_listings",
    label: "Wig Market Listings",
    description: "List active Bazaar offers, recent sales, and the current bot's wig balance.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      ensureSharedMarket(params);
      const marketStore = new WigForgeMarketStore(resolveWigForgeMarketRoot(params.config));
      const market = await marketStore.read();
      const inventory = await store.read();
      const summary = summarizeMarketDocument({
        market,
        inventoryKey: params.ctx.agentId || "default-agent",
      });
      return textResult(
        `Bazaar: ${summary.activeListings.length} active listing(s), ${summary.recentSales.length} recent sale(s). Wig balance: ${inventory.wallet?.wigBalance ?? 0}.`,
        {
          market,
          activeListings: summary.activeListings,
          recentSales: summary.recentSales,
          wallet: inventory.wallet,
        },
      );
    },
  };

  const marketOfferTool: AnyAgentTool = {
    name: "wig_market_offer",
    label: "Wig Market Offer",
    description: "List one owned asset for sale in the Bazaar for a wig price.",
    parameters: MarketOfferSchema,
    async execute(_toolCallId, rawParams) {
      ensureSharedMarket(params);
      const result = await createMarketListing({
        config: params.config,
        input: {
          inventoryKey: params.ctx.agentId || "default-agent",
          assetId: String((rawParams as { assetId?: string }).assetId || "").trim(),
          priceWig: Number((rawParams as { priceWig?: number }).priceWig),
          note:
            typeof (rawParams as { note?: string }).note === "string"
              ? (rawParams as { note?: string }).note
              : undefined,
        },
      });
      return textResult(
        `Listed ${result.listing.assetSnapshot.name} for ${result.listing.priceWig} wig.`,
        {
          listing: result.listing,
          market: result.market,
          inventory: result.inventory,
        },
      );
    },
  };

  const marketCancelTool: AnyAgentTool = {
    name: "wig_market_cancel",
    label: "Wig Market Cancel",
    description: "Withdraw one active Bazaar listing created by this bot.",
    parameters: MarketCancelSchema,
    async execute(_toolCallId, rawParams) {
      ensureSharedMarket(params);
      const result = await cancelMarketListing({
        config: params.config,
        input: {
          inventoryKey: params.ctx.agentId || "default-agent",
          listingId: String((rawParams as { listingId?: string }).listingId || "").trim(),
        },
      });
      return textResult(
        `Withdrew listing ${result.listing.id} for ${result.listing.assetSnapshot.name}.`,
        {
          listing: result.listing,
          market: result.market,
        },
      );
    },
  };

  const marketBuyTool: AnyAgentTool = {
    name: "wig_market_buy",
    label: "Wig Market Buy",
    description:
      "Buy one active Bazaar listing for the current bot and transfer the asset into its inventory.",
    parameters: MarketBuySchema,
    async execute(_toolCallId, rawParams) {
      ensureSharedMarket(params);
      const result = await purchaseMarketListing({
        config: params.config,
        input: {
          inventoryKey: params.ctx.agentId || "default-agent",
          listingId: String((rawParams as { listingId?: string }).listingId || "").trim(),
        },
      });
      return textResult(
        `Bought ${result.asset.name} for ${result.listing.priceWig} wig. New balance: ${result.buyerInventory.wallet?.wigBalance ?? 0}.`,
        result,
      );
    },
  };

  return [
    mintTool,
    listTool,
    equipTool,
    wishCreateTool,
    wishListTool,
    wishGrantTool,
    marketListTool,
    marketOfferTool,
    marketCancelTool,
    marketBuyTool,
  ];
}

function ensureSharedMarket(params: { config: WigForgeResolvedConfig }) {
  if (!params.config.storageDir) {
    throw new Error(
      "Bazaar tools require plugin config `storageDir` so multiple agents can share the market.",
    );
  }
}
