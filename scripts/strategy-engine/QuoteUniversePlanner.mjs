/**
 * QuoteUniversePlanner.mjs — 三層報價訂閱架構
 *
 * 層級：
 *   core             → 即時 tick，TX00/TX06 + 海外核心 10 檔（低流量、穩定）
 *   strategy-universe → 即時 tick，策略候選商品（台指/電指/金融/A50/美股指/能源/金屬/外匯）
 *   all-scan         → 分批輪詢 freshness/availability/liquidity，不做即時 tick
 *
 * 輸入：
 *   - hft_stock_list.json（國內 6176 檔）
 *   - hft_os_product_list.json（海外 1252 檔）
 *   - strategies.json（策略候選清單）
 *
 * 輸出：
 *   - core.json           → QuoteHub.start(core) 用
 *   - strategy-universe.json → QuoteHub.start(universe) 用
 *   - all-scan.json       → freshness scanner 用（分批 snapshot）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════
// 路徑
// ═══════════════════════════════════════════════════════════════
const HFT_DIR =
  process.env.CAPITAL_HFT_DIR ??
  (existsSync("D:\\群益及元大API\\CapitalHftService")
    ? "D:\\群益及元大API\\CapitalHftService"
    : "");
const STOCK_LIST = path.join(HFT_DIR, "hft_stock_list.json");
const OS_LIST = path.join(HFT_DIR, "hft_os_product_list.json");
const ENGINE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const CONFIG_DIR = path.join(ENGINE_DIR, "config");
const OUTPUT_DIR = path.join(CONFIG_DIR, "universe");

// ═══════════════════════════════════════════════════════════════
// 核心商品定義
// ═══════════════════════════════════════════════════════════════

/** core 層：永遠即時 tick 的商品 */
const CORE_DOMESTIC = ["TX00", "TX06"];
const CORE_OVERSEAS = [
  "ES0000", // E-mini S&P 500
  "NQ0000", // E-mini Nasdaq 100
  "YM0000", // E-mini Dow
  "CL0000", // 輕原油
  "GC0000", // 黃金
  "SI0000", // 白銀
  "CN0000", // A50（富時中國）
  "NK0000", // 日經
  "DAX0000", // 德國 DAX（若有）
  "HSI0000", // 恆生指數（若有）
];
const CORE_OKX = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "BTC-USDT", "ETH-USDT"];

/** strategy-universe 層：策略候選群（即時 tick） */
const UNIVERSE_DOMESTIC_PREFIXES = [
  "TX",
  "MTX",
  "TM", // 台指系列
  "TE",
  "ZE", // 電子期
  "TF",
  "ZF", // 金融期
  "TG", // 台灣50期
  "XI", // 非金電期
  "GT", // 櫃買期
];
const UNIVERSE_OVERSEAS_PREFIXES = [
  "ES",
  "NQ",
  "YM",
  "MYM",
  "MNQ",
  "MES", // 美股指
  "CL",
  "MCL",
  "NG", // 能源
  "GC",
  "MGC",
  "SI", // 金屬
  "CN",
  "A50", // 中國
  "NK",
  "MNK", // 日本
  "HSI",
  "MHI", // 香港
  "DAX",
  "FDAX", // 歐洲
  "EUR",
  "JPY",
  "GBP",
  "AUD", // 外匯
  "6E",
  "6J",
  "6B",
  "6A", // CME 外匯
  "ZB",
  "ZN",
  "ZF", // 美債
];
const UNIVERSE_OKX = [
  "BTC-USDT-SWAP",
  "ETH-USDT-SWAP",
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT-SWAP",
  "SOL-USDT",
  "BNB-USDT-SWAP",
  "XRP-USDT-SWAP",
  "DOGE-USDT-SWAP",
  "ARB-USDT-SWAP",
  "AVAX-USDT-SWAP",
  "MATIC-USDT-SWAP",
  "LINK-USDT-SWAP",
  "OP-USDT-SWAP",
];

// ═══════════════════════════════════════════════════════════════
// 主邏輯
// ═══════════════════════════════════════════════════════════════
export class QuoteUniversePlanner {
  constructor() {
    this._domesticAll = []; // 所有國內期貨（近月）
    this._overseasAll = []; // 所有海外期貨代碼
    this._loaded = false;
  }

  /** 載入商品池 */
  load() {
    // 國內期貨
    if (existsSync(STOCK_LIST)) {
      const data = JSON.parse(readFileSync(STOCK_LIST, "utf-8"));
      const m2 = data.markets?.["2"] ?? [];
      for (const item of m2) {
        const code = item.quoteCode ?? "";
        if (!code || code === "##") {
          continue;
        }
        const base = code.endsWith("AM") ? code.slice(0, -2) : code;
        this._domesticAll.push({ code: base, name: item.name ?? "", expiry: item.expiry ?? "" });
      }
    }
    // 海外期貨
    if (existsSync(OS_LIST)) {
      const data = JSON.parse(readFileSync(OS_LIST, "utf-8"));
      const products = data.products ?? [];
      for (const line of products) {
        const parts = line.split(",");
        if (parts.length >= 3) {
          this._overseasAll.push({
            code: parts[2],
            name: parts[3] ?? "",
            exchange: parts[0] ?? "",
          });
        }
      }
    }
    this._loaded = true;
    return this;
  }

  /** 產出 core 層 */
  planCore() {
    const domestic = [...CORE_DOMESTIC];
    // 海外：取可用的核心商品
    const overseas = this._matchOverseas(CORE_OVERSEAS);
    return {
      tier: "core",
      description: "即時 tick — 最重要的少量商品，永遠在線",
      domestic,
      overseas: overseas.map((o) => o.code),
      okx: [...CORE_OKX],
      totalLiveTick: domestic.length + overseas.length + CORE_OKX.length,
    };
  }

  /** 產出 strategy-universe 層 */
  planStrategyUniverse() {
    // 國內：只取近月（名字含"近"）且符合 prefix
    const domestic = [];
    const seen = new Set();
    for (const item of this._domesticAll) {
      if (!item.name.includes("近")) {
        continue;
      }
      const matchPrefix = UNIVERSE_DOMESTIC_PREFIXES.some((p) => item.code.startsWith(p));
      if (matchPrefix && !seen.has(item.code)) {
        domestic.push(item.code);
        seen.add(item.code);
      }
    }
    // 海外：只取近月（code 含 0000 或結尾 00）且符合 prefix
    const overseas = [];
    const osSeen = new Set();
    for (const item of this._overseasAll) {
      const isHot =
        item.code.endsWith("0000") || (item.code.match(/\d{2}$/) && item.name.includes("熱"));
      const matchPrefix = UNIVERSE_OVERSEAS_PREFIXES.some((p) => item.code.startsWith(p));
      if (matchPrefix && isHot && !osSeen.has(item.code)) {
        overseas.push(item.code);
        osSeen.add(item.code);
      }
    }
    return {
      tier: "strategy-universe",
      description: "即時 tick — 策略候選商品池，中等流量",
      domestic,
      overseas,
      okx: [...UNIVERSE_OKX],
      totalLiveTick: domestic.length + overseas.length + UNIVERSE_OKX.length,
    };
  }

  /** 產出 all-scan 層（所有商品，分批輪詢用） */
  planAllScan() {
    const domesticCodes = [...new Set(this._domesticAll.map((i) => i.code))];
    const overseasCodes = [...new Set(this._overseasAll.map((i) => i.code))];
    return {
      tier: "all-scan",
      description: "分批輪詢 — 全商品 freshness/availability/liquidity 掃描，非即時 tick",
      domesticCount: domesticCodes.length,
      overseasCount: overseasCodes.length,
      totalPool: domesticCodes.length + overseasCodes.length,
      batchSize: 50,
      scanIntervalMs: 60_000,
      domestic: domesticCodes,
      overseas: overseasCodes,
    };
  }

  /** 輸出所有層級的 JSON 到 config/universe/ */
  writeAll() {
    if (!this._loaded) {
      this.load();
    }
    if (!existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const core = this.planCore();
    const universe = this.planStrategyUniverse();
    const allScan = this.planAllScan();

    const meta = {
      schema: "openclaw.quote-universe-plan.v1",
      generatedAt: new Date().toISOString(),
      source: { stockList: STOCK_LIST, osList: OS_LIST },
    };

    writeFileSync(
      path.join(OUTPUT_DIR, "core.json"),
      JSON.stringify({ ...meta, ...core }, null, 2),
      "utf-8",
    );
    writeFileSync(
      path.join(OUTPUT_DIR, "strategy-universe.json"),
      JSON.stringify({ ...meta, ...universe }, null, 2),
      "utf-8",
    );
    writeFileSync(
      path.join(OUTPUT_DIR, "all-scan.json"),
      JSON.stringify(
        {
          ...meta,
          tier: allScan.tier,
          description: allScan.description,
          domesticCount: allScan.domesticCount,
          overseasCount: allScan.overseasCount,
          totalPool: allScan.totalPool,
          batchSize: allScan.batchSize,
          scanIntervalMs: allScan.scanIntervalMs,
        },
        null,
        2,
      ),
      "utf-8",
    );
    // all-scan 完整清單另存（避免主 JSON 太大）
    writeFileSync(
      path.join(OUTPUT_DIR, "all-scan-codes.json"),
      JSON.stringify({ ...meta, domestic: allScan.domestic, overseas: allScan.overseas }, null, 2),
      "utf-8",
    );

    return {
      core,
      universe,
      allScan: {
        ...allScan,
        domestic: `[${allScan.domesticCount}]`,
        overseas: `[${allScan.overseasCount}]`,
      },
    };
  }

  /** 根據模式取得要傳給 QuoteHub.start() 的 instruments 清單 */
  getInstruments(mode = "core") {
    if (!this._loaded) {
      this.load();
    }
    if (mode === "core") {
      const plan = this.planCore();
      return [...plan.domestic, ...plan.overseas, ...plan.okx];
    }
    if (mode === "strategy-universe") {
      const plan = this.planStrategyUniverse();
      return [...plan.domestic, ...plan.overseas, ...plan.okx];
    }
    // all-scan 不回傳全部，由 scanner 分批處理
    return [];
  }

  /** 匹配海外商品 */
  _matchOverseas(targets) {
    const matched = [];
    for (const target of targets) {
      const found = this._overseasAll.find((i) => i.code === target);
      if (found) {
        matched.push(found);
      }
    }
    return matched;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI：node QuoteUniversePlanner.mjs [--write]
// ═══════════════════════════════════════════════════════════════
if (process.argv[1]?.endsWith("QuoteUniversePlanner.mjs")) {
  const planner = new QuoteUniversePlanner().load();
  const doWrite = process.argv.includes("--write");

  if (doWrite) {
    const result = planner.writeAll();
    console.log("[QuoteUniversePlanner] Written to:", OUTPUT_DIR);
    console.log("  core:", result.core.totalLiveTick, "live ticks");
    console.log("  strategy-universe:", result.universe.totalLiveTick, "live ticks");
    console.log(
      "  all-scan:",
      result.allScan.domesticCount,
      "domestic +",
      result.allScan.overseasCount,
      "overseas (batch poll)",
    );
  } else {
    // dry-run
    const core = planner.planCore();
    const universe = planner.planStrategyUniverse();
    const allScan = planner.planAllScan();
    console.log("=== Quote Universe Plan (dry-run) ===");
    console.log(`\n[core] ${core.totalLiveTick} live ticks`);
    console.log(`  domestic: ${core.domestic.join(", ")}`);
    console.log(`  overseas: ${core.overseas.join(", ")}`);
    console.log(`  okx: ${core.okx.join(", ")}`);
    console.log(`\n[strategy-universe] ${universe.totalLiveTick} live ticks`);
    console.log(`  domestic (${universe.domestic.length}): ${universe.domestic.join(", ")}`);
    console.log(`  overseas (${universe.overseas.length}): ${universe.overseas.join(", ")}`);
    console.log(`  okx (${universe.okx.length}): ${universe.okx.join(", ")}`);
    console.log(`\n[all-scan] ${allScan.totalPool} total (batch poll, not live tick)`);
    console.log(`  domestic: ${allScan.domesticCount}, overseas: ${allScan.overseasCount}`);
    console.log(`  batchSize: ${allScan.batchSize}, interval: ${allScan.scanIntervalMs}ms`);
  }
}

export default QuoteUniversePlanner;
