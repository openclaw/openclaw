import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Structural lint tests for the Mars shopee JIT skill suite.
 *
 * Validates that all subcommand files follow required conventions:
 * - Required sections (gates, findings output)
 * - Cross-references (dependsOn targets exist, daily-ops phases map to files)
 * - Keyword coverage (SKILL.md description includes all router keywords)
 * - Stacking formula consistency
 * - URL format validity
 *
 * Requires OPENCLAW_LIVE_TEST=1 to run (reads real ~/.openclaw/skills/shopee/).
 */

const REAL_SHOPEE_DIR = path.join(os.homedir(), ".openclaw", "skills", "shopee");
const shopeeExists = fs.existsSync(path.join(REAL_SHOPEE_DIR, "router.json"));

interface RouterManifest {
  suite: string;
  alwaysInject: string[];
  subcommands: Record<
    string,
    {
      keywords: string[];
      description?: string;
      dependsOn: string[];
      isSystem: boolean;
    }
  >;
}

let router: RouterManifest;
let skillMd: string;
let subcommandFiles: Map<string, string>;
let globalRules: string;

beforeAll(() => {
  if (!shopeeExists) return;
  router = JSON.parse(fs.readFileSync(path.join(REAL_SHOPEE_DIR, "router.json"), "utf-8"));
  skillMd = fs.readFileSync(path.join(REAL_SHOPEE_DIR, "SKILL.md"), "utf-8");
  globalRules = fs.readFileSync(path.join(REAL_SHOPEE_DIR, "global-rules.md"), "utf-8");

  subcommandFiles = new Map();
  for (const name of Object.keys(router.subcommands)) {
    const filePath = path.join(REAL_SHOPEE_DIR, `${name}.md`);
    if (fs.existsSync(filePath)) {
      subcommandFiles.set(name, fs.readFileSync(filePath, "utf-8"));
    }
  }
});

describe.skipIf(!shopeeExists)("shopee skill structural lint", () => {
  // ─── 1. router.json validity ──────────────────────────────────────
  describe("router.json structure", () => {
    it("has valid JSON with suite name", () => {
      expect(router.suite).toBe("shopee");
    });

    it("has alwaysInject with global-rules", () => {
      expect(router.alwaysInject).toContain("global-rules");
    });

    it("has 24 subcommands (23 + test-suite)", () => {
      expect(Object.keys(router.subcommands)).toHaveLength(24);
    });

    it("every subcommand has keywords array", () => {
      for (const [name, sub] of Object.entries(router.subcommands)) {
        expect(sub.keywords, `${name} missing keywords`).toBeInstanceOf(Array);
        expect(sub.keywords.length, `${name} has empty keywords`).toBeGreaterThan(0);
      }
    });

    it("every subcommand has dependsOn array", () => {
      for (const [name, sub] of Object.entries(router.subcommands)) {
        expect(sub.dependsOn, `${name} missing dependsOn`).toBeInstanceOf(Array);
      }
    });

    it("only daily-ops and test-suite have isSystem:true", () => {
      const systemSubs = new Set(["daily-ops", "test-suite"]);
      for (const [name, sub] of Object.entries(router.subcommands)) {
        if (systemSubs.has(name)) {
          expect(sub.isSystem, `${name} should be isSystem`).toBe(true);
        } else {
          expect(sub.isSystem, `${name} should not be isSystem`).toBe(false);
        }
      }
    });
  });

  // ─── 2. dependsOn targets exist ──────────────────────────────────
  describe("dependsOn references", () => {
    it("all dependsOn targets exist as subcommands in router.json", () => {
      const allNames = new Set(Object.keys(router.subcommands));
      for (const [name, sub] of Object.entries(router.subcommands)) {
        for (const dep of sub.dependsOn) {
          expect(allNames.has(dep), `${name} depends on "${dep}" which doesn't exist`).toBe(true);
        }
      }
    });

    it("margin-check has no dependencies (it's the root gate)", () => {
      expect(router.subcommands["margin-check"]?.dependsOn).toEqual([]);
    });

    it("spend subcommands depend on margin-check", () => {
      const spendSubs = [
        "ads",
        "voucher",
        "campaign",
        "flash-deal",
        "listing",
        "pricing",
        "discount-promo",
        "shipping-promo",
        "chat-broadcast",
      ];
      for (const name of spendSubs) {
        expect(
          router.subcommands[name]?.dependsOn,
          `${name} should depend on margin-check`,
        ).toContain("margin-check");
      }
    });
  });

  // ─── 3. Every subcommand has a matching .md file ──────────────────
  describe("subcommand file existence", () => {
    it("every router subcommand has a matching .md file", () => {
      for (const name of Object.keys(router.subcommands)) {
        expect(subcommandFiles.has(name), `missing file: ${name}.md`).toBe(true);
      }
    });

    it("global-rules.md exists (alwaysInject)", () => {
      expect(fs.existsSync(path.join(REAL_SHOPEE_DIR, "global-rules.md"))).toBe(true);
    });
  });

  // ─── 4. Gate references ───────────────────────────────────────────
  describe("gate references in margin-dependent subcommands", () => {
    const marginDeps = [
      "ads",
      "voucher",
      "campaign",
      "flash-deal",
      "pricing",
      "discount-promo",
      "shipping-promo",
      "chat-broadcast",
    ];

    for (const name of marginDeps) {
      it(`${name}.md references margin gate or margin check`, () => {
        const content = subcommandFiles.get(name) ?? "";
        const hasMarginRef =
          content.includes("gate_margin") ||
          content.includes("margin-check") ||
          content.includes("margin check") ||
          content.includes("Margin") ||
          content.includes("margin gate") ||
          content.toLowerCase().includes("margin") ||
          content.includes("floor_price") ||
          content.includes("min_profit");
        expect(hasMarginRef, `${name}.md should reference margin gate/check`).toBe(true);
      });
    }
  });

  // ─── 5. Findings Output sections ──────────────────────────────────
  describe("findings output sections", () => {
    const requiresFindings = [
      "ads",
      "stock",
      "listing",
      "pricing",
      "business-insights",
      "discount-promo",
      "shipping-promo",
      "affiliate",
      "review-mgmt",
      "shop-health",
      "chat-broadcast",
      "sync-drain",
      "label-fetch",
      "reconcile",
    ];

    for (const name of requiresFindings) {
      it(`${name}.md has Findings Output section`, () => {
        const content = subcommandFiles.get(name) ?? "";
        const hasFindings =
          content.toLowerCase().includes("findings output") ||
          content.toLowerCase().includes("findings json") ||
          content.toLowerCase().includes('"findings"') ||
          content.includes("GREEN") ||
          content.includes("YELLOW");
        expect(hasFindings, `${name}.md should have Findings Output section`).toBe(true);
      });
    }
  });

  // ─── 6. URL format validation ─────────────────────────────────────
  describe("URL format in subcommand files", () => {
    const urlPattern = /https?:\/\/seller\.shopee\.sg\/[^\s)'"]+/g;

    it("all seller.shopee.sg URLs are valid format", () => {
      const issues: string[] = [];
      for (const [name, content] of subcommandFiles) {
        const urls = content.match(urlPattern) ?? [];
        for (const url of urls) {
          if (url.includes("//portal//") || url.includes("..") || url.includes(" ")) {
            issues.push(`${name}: malformed URL: ${url}`);
          }
        }
      }
      expect(issues, `URL format issues found:\n${issues.join("\n")}`).toEqual([]);
    });

    const requiresUrls = [
      "ads",
      "voucher",
      "flash-deal",
      "stock",
      "chat",
      "listing",
      "order-ingest",
      "label-fetch",
      "delivery-poll",
      "reconcile",
      "settlement",
      "business-insights",
      "discount-promo",
      "shipping-promo",
      "affiliate",
      "review-mgmt",
      "shop-health",
      "chat-broadcast",
    ];

    for (const name of requiresUrls) {
      it(`${name}.md contains seller centre URLs`, () => {
        const content = subcommandFiles.get(name) ?? "";
        const hasUrl = content.includes("seller.shopee.sg") || content.includes("search.shopee.sg");
        expect(hasUrl, `${name}.md should have Shopee seller centre URLs`).toBe(true);
      });
    }
  });

  // ─── 7. SKILL.md keyword coverage ─────────────────────────────────
  describe("SKILL.md keyword coverage", () => {
    it("SKILL.md description includes keywords for all subcommands", () => {
      const description = skillMd.toLowerCase();
      const missing: string[] = [];

      for (const [name, sub] of Object.entries(router.subcommands)) {
        const hasAny = sub.keywords.some((kw) => description.includes(kw.toLowerCase()));
        if (!hasAny) {
          missing.push(`${name}: none of [${sub.keywords.join(", ")}] found in SKILL.md`);
        }
      }
      expect(missing, `Missing keyword coverage:\n${missing.join("\n")}`).toEqual([]);
    });

    it("SKILL.md lists all subcommand names", () => {
      const missing: string[] = [];
      for (const name of Object.keys(router.subcommands)) {
        if (!skillMd.includes(name)) {
          missing.push(name);
        }
      }
      expect(missing, `Subcommands not listed in SKILL.md: ${missing.join(", ")}`).toEqual([]);
    });
  });

  // ─── 8. No exact keyword collisions ───────────────────────────────
  describe("keyword uniqueness", () => {
    it("no exact-match keyword appears in more than two subcommands", () => {
      const keywordOwners = new Map<string, string[]>();
      for (const [name, sub] of Object.entries(router.subcommands)) {
        for (const kw of sub.keywords) {
          const normalized = kw.toLowerCase();
          if (!keywordOwners.has(normalized)) {
            keywordOwners.set(normalized, []);
          }
          keywordOwners.get(normalized)!.push(name);
        }
      }

      const collisions: string[] = [];
      for (const [kw, owners] of keywordOwners) {
        if (owners.length > 1) {
          collisions.push(`"${kw}" → [${owners.join(", ")}]`);
        }
      }
      if (collisions.length > 0) {
        console.warn(`Keyword collisions (may cause routing ambiguity):\n${collisions.join("\n")}`);
      }
      const tripleCollisions = [...keywordOwners.entries()].filter(([, o]) => o.length >= 3);
      expect(
        tripleCollisions.map(([kw, owners]) => `"${kw}" → [${owners.join(", ")}]`),
        "Keywords appearing in 3+ subcommands",
      ).toEqual([]);
    });
  });

  // ─── 9. daily-ops phase references ────────────────────────────────
  describe("daily-ops phase references", () => {
    it("daily-ops.md references all expected subcommands", () => {
      const dailyOps = subcommandFiles.get("daily-ops") ?? "";
      const expectedRefs = [
        "margin-check",
        "business-insights",
        "order-ingest",
        "sync-drain",
        "reconcile",
        "shop-health",
        "pricing",
        "delivery-poll",
        "chat",
        "stock",
        "affiliate",
        "review-mgmt",
        "chat-broadcast",
      ];

      const missing: string[] = [];
      for (const ref of expectedRefs) {
        const altRef = ref.replace("-", " ").replace("-", " ");
        if (!dailyOps.includes(ref) && !dailyOps.toLowerCase().includes(altRef)) {
          missing.push(ref);
        }
      }
      expect(missing, `daily-ops.md missing phase references: ${missing.join(", ")}`).toEqual([]);
    });
  });

  // ─── 10. Stacking formula consistency ─────────────────────────────
  describe("stacking formula consistency", () => {
    it("global-rules.md contains the stacking formula", () => {
      expect(globalRules).toContain("discount_promo");
    });

    it("subcommands referencing stacking include discount_promo_amount", () => {
      const stackingSubs = ["voucher", "flash-deal", "campaign", "pricing", "discount-promo"];
      const missing: string[] = [];

      for (const name of stackingSubs) {
        const content = subcommandFiles.get(name) ?? "";
        const hasStackingRef =
          content.includes("discount_promo") ||
          content.includes("discount promo") ||
          content.includes("stacking") ||
          content.includes("worst-case") ||
          content.includes("worst case");
        if (!hasStackingRef) {
          missing.push(name);
        }
      }
      expect(
        missing,
        `Files missing stacking/discount-promo reference: ${missing.join(", ")}`,
      ).toEqual([]);
    });
  });

  // ─── 11. OMS tool call validation ─────────────────────────────────
  describe("OMS integration references", () => {
    const omsUsers = [
      { name: "margin-check", expectedRef: ["oms", "margin"] },
      { name: "stock", expectedRef: ["oms", "inventory"] },
      { name: "order-ingest", expectedRef: ["oms", "record_order"] },
      { name: "reconcile", expectedRef: ["oms", "reconcile"] },
      { name: "sync-drain", expectedRef: ["oms", "sync"] },
      { name: "settlement", expectedRef: ["oms", "settlement"] },
    ];

    for (const { name, expectedRef } of omsUsers) {
      it(`${name}.md references OMS`, () => {
        const content = subcommandFiles.get(name) ?? "";
        const hasOmsRef = expectedRef.some((ref) =>
          content.toLowerCase().includes(ref.toLowerCase()),
        );
        expect(hasOmsRef, `${name}.md should reference OMS tools`).toBe(true);
      });
    }
  });
});
