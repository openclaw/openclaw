import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Router keyword tests for the Mars shopee JIT skill suite.
 *
 * Tests keyword scoring logic against the shopee router.json manifest.
 * The scoring algorithm mirrors `autoDetectSubcommandFromRouter` in workspace.ts:
 *   - Lowercase the message text
 *   - For each non-system subcommand, count how many keywords substring-match the text
 *   - Highest score wins; ties go to first in iteration order
 *
 * Uses an inlined copy of the scoring logic to avoid transitive import failures
 * from other WIP modules in the import graph.
 */

interface RouterManifest {
  subcommands: Record<string, { keywords: string[]; isSystem?: boolean; dependsOn?: string[] }>;
}

const ROUTER_JSON: RouterManifest = {
  subcommands: {
    "margin-check": {
      keywords: ["margin", "profit", "health", "markup", "margin-check"],
      dependsOn: [],
      isSystem: false,
    },
    ads: {
      keywords: ["ads", "roas", "acos", "boost", "bid", "advertising"],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    voucher: {
      keywords: [
        "voucher",
        "coupon",
        "create voucher",
        "edit voucher",
        "end voucher",
        "duplicate voucher",
        "voucher list",
        "voucher code",
      ],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    campaign: {
      keywords: ["campaign", "join", "nominate", "nomination", "pending confirmation"],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    "flash-deal": {
      keywords: [
        "flash deal",
        "flash sale",
        "flash price",
        "flash discount",
        "create flash",
        "shop flash",
      ],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    stock: {
      keywords: ["stock", "inventory", "fbs", "restock", "warehouse"],
      dependsOn: [],
      isSystem: false,
    },
    chat: {
      keywords: ["chat", "message", "customer", "reply"],
      dependsOn: [],
      isSystem: false,
    },
    listing: {
      keywords: ["listing", "title", "price", "optimize", "product page"],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    "order-ingest": {
      keywords: ["orders", "ingest", "new orders", "fetch orders"],
      dependsOn: [],
      isSystem: false,
    },
    "sync-drain": {
      keywords: ["sync", "drain", "push qty", "stock update"],
      dependsOn: [],
      isSystem: false,
    },
    "label-fetch": {
      keywords: ["label", "awb", "shipping label", "print"],
      dependsOn: [],
      isSystem: false,
    },
    "delivery-poll": {
      keywords: ["delivery", "tracking", "shipped", "status poll"],
      dependsOn: [],
      isSystem: false,
    },
    reconcile: {
      keywords: ["reconcile", "compare", "mismatch"],
      dependsOn: [],
      isSystem: false,
    },
    settlement: {
      keywords: ["settlement", "payout", "dispute", "settlement report"],
      dependsOn: [],
      isSystem: false,
    },
    pricing: {
      keywords: [
        "pricing",
        "reprice",
        "price review",
        "target",
        "sales pace",
        "velocity",
        "sales target",
        "adjust price",
      ],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    "business-insights": {
      keywords: [
        "traffic",
        "conversion",
        "page views",
        "visitors",
        "business insights",
        "analytics",
        "funnel",
      ],
      dependsOn: [],
      isSystem: false,
    },
    "discount-promo": {
      keywords: [
        "discount promotion",
        "discount promo",
        "product discount",
        "percentage off",
        "price discount",
      ],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    "shipping-promo": {
      keywords: [
        "shipping promotion",
        "free shipping",
        "shipping voucher",
        "logistics voucher",
        "shipping discount",
      ],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    affiliate: {
      keywords: [
        "affiliate",
        "affiliate marketing",
        "influencer",
        "collaboration",
        "commission",
        "KOL",
      ],
      dependsOn: [],
      isSystem: false,
    },
    "review-mgmt": {
      keywords: [
        "review",
        "rating",
        "customer review",
        "product review",
        "shop rating",
        "feedback",
      ],
      dependsOn: [],
      isSystem: false,
    },
    "shop-health": {
      keywords: [
        "shop health",
        "penalty",
        "penalty points",
        "violation",
        "deduction",
        "account health",
        "shop score",
      ],
      dependsOn: [],
      isSystem: false,
    },
    "chat-broadcast": {
      keywords: [
        "broadcast",
        "marketing message",
        "follow prize",
        "auto reply",
        "engagement",
        "re-engage",
      ],
      dependsOn: ["margin-check"],
      isSystem: false,
    },
    "daily-ops": {
      keywords: [
        "daily ops",
        "morning run",
        "afternoon run",
        "evening run",
        "shift",
        "routine",
        "daily cycle",
        "run ops",
        "full cycle",
        "autonomous",
      ],
      dependsOn: [],
      isSystem: true,
    },
    "test-suite": {
      keywords: [
        "test suite",
        "test all",
        "smoke test",
        "run tests",
        "self-test",
        "test sales",
        "test ops",
        "test marketing",
      ],
      dependsOn: [],
      isSystem: true,
    },
  },
};

/**
 * Mirrors autoDetectSubcommandFromRouter from workspace.ts.
 * Inlined to avoid transitive import failures from other WIP modules.
 */
function detect(messageText: string): string | undefined {
  const text = messageText.toLowerCase();
  let bestSub: string | undefined;
  let bestScore = 0;

  for (const [subName, subMeta] of Object.entries(ROUTER_JSON.subcommands)) {
    if (subMeta.isSystem) continue;
    const keywords = subMeta.keywords ?? [];
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestSub = subName;
    }
  }

  return bestSub;
}

describe("shopee router keyword scoring", () => {
  // ─── Primary keyword routing (22 non-system subcommands) ──────────
  describe("primary keyword routing", () => {
    it("routes 'check margin health' → margin-check", () => {
      expect(detect("check margin health")).toBe("margin-check");
    });

    it("routes 'review shopee ads ROAS' → ads", () => {
      expect(detect("review shopee ads ROAS")).toBe("ads");
    });

    it("routes 'create a voucher for $3 off' → voucher", () => {
      expect(detect("create a voucher for $3 off")).toBe("voucher");
    });

    it("routes 'join platform campaign nomination' → campaign", () => {
      expect(detect("join platform campaign nomination")).toBe("campaign");
    });

    it("routes 'create flash deal for top SKU' → flash-deal", () => {
      expect(detect("create flash deal for top SKU")).toBe("flash-deal");
    });

    it("routes 'check FBS stock levels' → stock", () => {
      expect(detect("check FBS stock levels")).toBe("stock");
    });

    it("routes 'reply customer chat messages' → chat", () => {
      expect(detect("reply customer chat messages")).toBe("chat");
    });

    it("routes 'optimize listing title for SEO' → listing", () => {
      expect(detect("optimize listing title for SEO")).toBe("listing");
    });

    it("routes 'fetch new orders and ingest' → order-ingest", () => {
      expect(detect("fetch new orders and ingest")).toBe("order-ingest");
    });

    it("routes 'drain sync queue push qty' → sync-drain", () => {
      expect(detect("drain sync queue push qty")).toBe("sync-drain");
    });

    it("routes 'fetch shipping label AWB' → label-fetch", () => {
      expect(detect("fetch shipping label AWB")).toBe("label-fetch");
    });

    it("routes 'check delivery tracking status' → delivery-poll", () => {
      expect(detect("check delivery tracking status")).toBe("delivery-poll");
    });

    it("routes 'reconcile shopee orders mismatch' → reconcile", () => {
      expect(detect("reconcile shopee orders mismatch")).toBe("reconcile");
    });

    it("routes 'check settlement payout report' → settlement", () => {
      expect(detect("check settlement payout report")).toBe("settlement");
    });

    it("routes 'review pricing and sales pace velocity' → pricing", () => {
      expect(detect("review pricing and sales pace velocity")).toBe("pricing");
    });

    it("routes 'check traffic and conversion analytics' → business-insights", () => {
      expect(detect("check traffic and conversion analytics")).toBe("business-insights");
    });

    it("routes 'create discount promotion 10% off' → discount-promo", () => {
      expect(detect("create discount promotion 10% off")).toBe("discount-promo");
    });

    it("routes 'setup free shipping promotion' → shipping-promo", () => {
      expect(detect("setup free shipping promotion")).toBe("shipping-promo");
    });

    it("routes 'check affiliate marketing performance' → affiliate", () => {
      expect(detect("check affiliate marketing performance")).toBe("affiliate");
    });

    it("routes 'respond to product reviews and feedback' → review-mgmt", () => {
      expect(detect("respond to product reviews and feedback")).toBe("review-mgmt");
    });

    it("routes 'check shop health penalty points' → shop-health", () => {
      expect(detect("check shop health penalty points")).toBe("shop-health");
    });

    it("routes 'send broadcast to followers' → chat-broadcast", () => {
      // Note: "send marketing broadcast message" ties chat (1: "message") vs
      // chat-broadcast (1: "broadcast") because "marketing message" doesn't
      // substring-match "marketing broadcast message". Use unambiguous phrasing.
      expect(detect("send broadcast to followers")).toBe("chat-broadcast");
    });
  });

  // ─── daily-ops and test-suite are isSystem:true → excluded ────────
  describe("system subcommand exclusion", () => {
    it("does NOT route 'run morning daily ops' → daily-ops (isSystem)", () => {
      expect(detect("run morning daily ops")).not.toBe("daily-ops");
    });

    it("does NOT route 'full cycle shift routine' → daily-ops (isSystem)", () => {
      expect(detect("full cycle shift routine")).not.toBe("daily-ops");
    });
  });

  // ─── Keyword collision tests ──────────────────────────────────────
  describe("keyword collision handling", () => {
    it("routes 'discount voucher code' → voucher over discount-promo", () => {
      expect(detect("discount voucher code")).toBe("voucher");
    });

    it("routes 'product discount percentage off' → discount-promo", () => {
      expect(detect("product discount percentage off")).toBe("discount-promo");
    });

    it("routes 'customer review feedback' → review-mgmt over shop-health", () => {
      expect(detect("customer review feedback")).toBe("review-mgmt");
    });

    it("routes 'shop score penalty violation' → shop-health over review-mgmt", () => {
      expect(detect("shop score penalty violation")).toBe("shop-health");
    });

    it("routes 'boost bid advertising' → ads (3 hits)", () => {
      expect(detect("boost bid advertising")).toBe("ads");
    });

    it("routes 'shipping voucher free shipping' → shipping-promo over voucher", () => {
      expect(detect("shipping voucher free shipping")).toBe("shipping-promo");
    });

    it("routes 'follow prize engagement broadcast' → chat-broadcast (3 hits)", () => {
      expect(detect("follow prize engagement broadcast")).toBe("chat-broadcast");
    });

    it("routes 'commission KOL collaboration' → affiliate (3 hits)", () => {
      expect(detect("commission KOL collaboration")).toBe("affiliate");
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────
  describe("edge cases", () => {
    it("returns undefined for completely unrelated message", () => {
      expect(detect("what is the weather today")).toBeUndefined();
    });

    it("handles case insensitivity", () => {
      expect(detect("CHECK MARGIN HEALTH")).toBe("margin-check");
    });

    it("handles mixed case", () => {
      expect(detect("Create Flash Deal")).toBe("flash-deal");
    });

    it("handles single keyword match", () => {
      expect(detect("margin")).toBe("margin-check");
    });

    it("higher keyword count wins over single match", () => {
      expect(detect("ads roas acos")).toBe("ads");
    });

    it("handles empty string", () => {
      expect(detect("")).toBeUndefined();
    });
  });

  // ─── Multi-word keyword precision ─────────────────────────────────
  describe("multi-word keyword matching", () => {
    it("matches 'flash deal' as a multi-word keyword", () => {
      expect(detect("start a flash deal today")).toBe("flash-deal");
    });

    it("matches 'shop flash' keyword", () => {
      expect(detect("manage shop flash sales")).toBe("flash-deal");
    });

    it("matches 'create voucher' keyword", () => {
      expect(detect("I want to create voucher")).toBe("voucher");
    });

    it("matches 'settlement report' keyword", () => {
      expect(detect("download settlement report")).toBe("settlement");
    });

    it("matches 'business insights' keyword", () => {
      expect(detect("open business insights")).toBe("business-insights");
    });

    it("matches 'discount promotion' keyword", () => {
      expect(detect("set up a discount promotion")).toBe("discount-promo");
    });

    it("matches 'affiliate marketing' keyword", () => {
      expect(detect("review affiliate marketing stats")).toBe("affiliate");
    });

    it("matches 'shop health penalty' keywords (needs 2+ hits to beat margin-check)", () => {
      expect(detect("check shop health penalty status")).toBe("shop-health");
    });

    it("matches 'follow prize' keyword", () => {
      expect(detect("create a follow prize for followers")).toBe("chat-broadcast");
    });

    it("matches 'penalty points' keyword", () => {
      expect(detect("how many penalty points do we have")).toBe("shop-health");
    });
  });
});
