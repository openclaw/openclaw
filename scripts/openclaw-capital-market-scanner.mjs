/**
 * openclaw-capital-market-scanner.mjs
 * 群益 SKCOM 全商品「價量分析」掃描引擎
 *
 * 資料來源:
 *   - capital_quote_events.jsonl (國內期貨 tick)
 *   - os_symbol_cache.json (海外期貨 55+ 商品)
 *   - os_latest_quote_event.json
 *
 * 用法:
 *   node scripts/openclaw-capital-market-scanner.mjs [--market domestic|overseas|all] [--json] [--write-state]
 *
 * 安全: 純讀取，不下單
 */
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const REPORT_DIR = path.join(ROOT, "reports", "hermes-agent", "state");

function argVal(n, d = "") {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
function hasFlag(f) {
  return process.argv.includes(f);
}
const MARKET = argVal("--market", "all").toLowerCase();
const IS_JSON = hasFlag("--json");
const WRITE_STATE = hasFlag("--write-state");

// CapitalHftService 路徑候選
const HFT_CANDIDATES = [
  "D:\\群益及元大API\\CapitalHftService",
  path.join(ROOT, "..", "群益及元大API", "CapitalHftService"),
];

function findHftDir() {
  for (const d of HFT_CANDIDATES) {
    if (existsSync(d)) return d;
  }
  return null;
}

// ── 讀取國內期貨最新報價 ──
function readDomesticQuotes(hftDir) {
  const eventsFile = path.join(hftDir, "capital_quote_events.jsonl");
  if (!existsSync(eventsFile)) return [];

  // 讀最後 50KB 取得最新 tick
  const buf = readFileSync(eventsFile);
  const tail = buf.slice(Math.max(0, buf.length - 50000)).toString("utf-8");
  const lines = tail.split("\n").filter((l) => l.trim());

  const latest = new Map(); // symbol → 最新資料
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      const sym = d.stockNo || d.symbol;
      if (!sym) continue;
      if (!latest.has(sym) || (d.ts || 0) >= (latest.get(sym).ts || 0)) {
        latest.set(sym, d);
      }
    } catch {}
  }

  return Array.from(latest.entries()).map(([sym, d]) => ({
    symbol: sym,
    name: d.stockName || d.name || sym,
    market: "domestic",
    last: parseFloat(d.close || d.price || d.last || 0),
    open: parseFloat(d.open || 0),
    high: parseFloat(d.high || 0),
    low: parseFloat(d.low || 0),
    volume: parseFloat(d.totalVolume || d.volume || d.vol || 0),
    ts: d.ts || d.receivedAt || "",
  }));
}

// ── 讀取海外期貨報價 ──
function readOverseasQuotes(hftDir) {
  const cacheFile = path.join(hftDir, "os_symbol_cache.json");
  if (!existsSync(cacheFile)) return [];

  const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
  const symbols = cache.symbols || {};

  return Object.entries(symbols).map(([code, info]) => ({
    symbol: code,
    name: info.name || info.stockName || code,
    market: "overseas",
    last: parseFloat(info.close || info.last || info.price || 0),
    open: parseFloat(info.open || 0),
    high: parseFloat(info.high || 0),
    low: parseFloat(info.low || 0),
    volume: parseFloat(info.totalVolume || info.volume || info.vol || 0),
    bid: parseFloat(info.bid || 0),
    ask: parseFloat(info.ask || 0),
    ts: info.ts || info.receivedAt || cache.generatedAt || "",
  }));
}

// ── 價量評分 (單一快照版，無 K 線歷史) ──
function scoreSingleQuote(q) {
  let score = 50;
  let pvType = "中性";

  if (!q.last || q.last <= 0) return { score: 0, pvType: "無報價" };

  // 日內漲跌
  const chg = q.open > 0 ? ((q.last - q.open) / q.open) * 100 : 0;
  // 振幅
  const range = q.open > 0 ? ((q.high - q.low) / q.open) * 100 : 0;
  // 位置 (收盤在日內高低的位置)
  const position = q.high - q.low > 0 ? (q.last - q.low) / (q.high - q.low) : 0.5;

  // 量能（簡易判斷：有量 > 無量）
  const hasVol = q.volume > 0;

  // 價漲 + 收在高檔 + 有量 = 強勢
  if (chg > 0.3 && position > 0.7 && hasVol) {
    pvType = "價漲收高";
    score = 75;
    if (chg > 1) score += 5;
    if (position > 0.9) score += 5;
  }
  // 價漲但收在低檔 = 上影線 = 壓力
  else if (chg > 0 && position < 0.3) {
    pvType = "上影線壓力";
    score = 35;
  }
  // 價跌但收在高檔 = 下影線 = 支撐
  else if (chg < 0 && position > 0.7) {
    pvType = "下影線支撐";
    score = 65;
  }
  // 價跌收低 = 弱勢
  else if (chg < -0.3 && position < 0.3) {
    pvType = "價跌收低";
    score = 25;
    if (chg < -1) score -= 5;
  }
  // 窄幅盤整
  else if (range < 0.5) {
    pvType = "窄幅盤整";
    score = 45;
  } else {
    pvType = "中性";
    score = 50;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    pvType,
    chg: Math.round(chg * 100) / 100,
    range: Math.round(range * 100) / 100,
    position: Math.round(position * 100) / 100,
    hasVolume: hasVol,
  };
}

async function main() {
  const now = new Date();
  const hftDir = findHftDir();

  console.log(`\n=== 群益全商品價量掃描 ===`);
  console.log(`時間: ${now.toISOString()}`);
  console.log(`市場: ${MARKET}`);
  console.log(`CapitalHftService: ${hftDir || "未找到"}\n`);

  if (!hftDir) {
    console.error("❌ 找不到 CapitalHftService 目錄");
    process.exit(1);
  }

  let quotes = [];
  if (MARKET === "domestic" || MARKET === "all") {
    quotes.push(...readDomesticQuotes(hftDir));
  }
  if (MARKET === "overseas" || MARKET === "all") {
    quotes.push(...readOverseasQuotes(hftDir));
  }

  console.log(
    `商品數: ${quotes.length} (國內: ${quotes.filter((q) => q.market === "domestic").length}, 海外: ${quotes.filter((q) => q.market === "overseas").length})`,
  );

  // 評分
  const results = quotes
    .map((q) => {
      const analysis = scoreSingleQuote(q);
      return { ...q, ...analysis };
    })
    .sort((a, b) => b.score - a.score);

  const report = {
    schema: "openclaw.capital.market-scanner.v1",
    generatedAt: now.toISOString(),
    market: MARKET,
    totalInstruments: results.length,
    domestic: results.filter((r) => r.market === "domestic").length,
    overseas: results.filter((r) => r.market === "overseas").length,
    methodology: "價量分析: 日內漲跌 + 收盤位置(高低) + 量能 + 振幅",
    topCandidates: results.filter((r) => r.score >= 65),
    allResults: results,
    disclaimer: "價量分析僅供研究參考，不構成投資建議。不保證獲利，交易有風險。",
    safety: { orderPlacementEnabled: false, liveTradingEnabled: false, readOnlyAnalysisOnly: true },
  };

  if (IS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      "\n排名 | 商品         | 名稱              | 市場 | 價格        | 漲跌%  | 分數 | 價量型態     | 位置  | 振幅%",
    );
    console.log("─".repeat(110));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(
        `${String(i + 1).padStart(2)} | ${r.symbol.padEnd(12)} | ` +
          `${(r.name || "").slice(0, 16).padEnd(16)} | ` +
          `${r.market === "domestic" ? "國內" : "海外"} | ` +
          `${String(r.last).padStart(11)} | ` +
          `${((r.chg > 0 ? "+" : "") + r.chg + "%").padStart(7)} | ` +
          `${String(r.score).padStart(3)}  | ` +
          `${(r.pvType || "?").padEnd(12)} | ` +
          `${String(r.position || "-").padStart(5)} | ` +
          `${r.range || "-"}%`,
      );
    }
    const strong = results.filter((r) => r.score >= 65);
    console.log(`\n🔥 強勢候選 (≥65分): ${strong.length} 個`);
    for (const s of strong) {
      console.log(
        `  ${s.symbol} (${s.name}): ${s.pvType} (${s.score}分) — ${s.chg > 0 ? "+" : ""}${s.chg}%, 位置${s.position}`,
      );
    }
    console.log(`\n⚠️ 價量分析僅供研究參考，不構成投資建議。`);
  }

  if (WRITE_STATE) {
    await fs.mkdir(REPORT_DIR, { recursive: true });
    const rp = path.join(REPORT_DIR, "openclaw-capital-market-scanner-latest.json");
    const payload = JSON.stringify(report, null, 2) + "\n";
    await fs.writeFile(rp, payload);
    await fs.writeFile(
      rp + ".sha256",
      crypto.createHash("sha256").update(payload).digest("hex").toUpperCase() + "\n",
      "ascii",
    );
    console.log(`\n報告: ${rp}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
