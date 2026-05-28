/**
 * openclaw-okx-market-scanner.mjs
 * OKX 全商品「價量分析」掃描引擎
 *
 * 核心邏輯：價量關係為第一優先
 *   價漲量增 → 強勢多頭（最佳進場）
 *   價跌量縮 → 賣壓枯竭（反彈候選）
 *   價漲量縮 → 虛漲（迴避）
 *   價跌量增 → 強勢空頭（迴避）
 *   量能突破 + 價格突破 → 最高分
 *
 * 用法:
 *   node scripts/openclaw-okx-market-scanner.mjs [--top 30] [--type SPOT|SWAP] [--json] [--write-state]
 *
 * 安全: 純讀取，不下單
 */
import crypto from "node:crypto";
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
const TOP_N = parseInt(argVal("--top", "30"), 10);
const INST_TYPE = argVal("--type", "SPOT").toUpperCase();
const IS_JSON = hasFlag("--json");
const WRITE_STATE = hasFlag("--write-state");

const OKX_BASE = "https://www.okx.com";

async function okxFetch(endpoint) {
  const url = `${OKX_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "OpenClaw/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${url}`);
  const body = await res.json();
  if (body.code !== "0") throw new Error(`OKX error ${body.code}: ${body.msg}`);
  return body.data;
}

async function fetchAllTickers(instType) {
  const data = await okxFetch(`/api/v5/market/tickers?instType=${instType}`);
  return data
    .filter((t) => parseFloat(t.volCcy24h) > 10000) // 過濾低流動性
    .map((t) => ({
      instId: t.instId,
      last: parseFloat(t.last),
      open24h: parseFloat(t.open24h),
      high24h: parseFloat(t.high24h),
      low24h: parseFloat(t.low24h),
      vol24h: parseFloat(t.vol24h),
      volCcy24h: parseFloat(t.volCcy24h),
      chg24h: ((parseFloat(t.last) - parseFloat(t.open24h)) / parseFloat(t.open24h)) * 100,
      ts: parseInt(t.ts),
    }))
    .sort((a, b) => b.volCcy24h - a.volCcy24h);
}

async function fetchCandles(instId, bar = "1H", limit = 100) {
  const data = await okxFetch(`/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
  return data
    .map((c) => ({
      ts: parseInt(c[0]),
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      vol: parseFloat(c[5]),
    }))
    .reverse();
}

// ── 價量分析核心 ──

function avgVolume(volumes, period) {
  if (volumes.length < period) return volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function priceVolumeAnalysis(candles) {
  if (!candles || candles.length < 20) return null;
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const volumes = candles.map((c) => c.vol);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);

  // ── 1. 量能分析 (權重 40%) ──
  const vol5 = avgVolume(volumes, 5); // 近 5 根均量
  const vol20 = avgVolume(volumes, 20); // 20 根均量
  const volNow = volumes[n - 1]; // 最新一根量
  const volRatio5 = vol20 > 0 ? vol5 / vol20 : 1; // 短期量 vs 中期量
  const volRatioNow = vol20 > 0 ? volNow / vol20 : 1; // 當根量 vs 均量

  // 量能持續放大（連續 3 根量增）
  const volExpanding = volumes[n - 1] > volumes[n - 2] && volumes[n - 2] > volumes[n - 3];
  // 量能萎縮
  const volShrinking = volumes[n - 1] < volumes[n - 2] && volumes[n - 2] < volumes[n - 3];

  // ── 2. 價格趨勢分析 (權重 30%) ──
  const priceChg3 = ((closes[n - 1] - closes[n - 4]) / closes[n - 4]) * 100; // 近 3 根漲跌%
  const priceChg10 = ((closes[n - 1] - closes[n - 11]) / closes[n - 11]) * 100; // 近 10 根漲跌%
  const priceUp3 = closes[n - 1] > closes[n - 2] && closes[n - 2] > closes[n - 3]; // 連 3 漲
  const priceDown3 = closes[n - 1] < closes[n - 2] && closes[n - 2] < closes[n - 3]; // 連 3 跌

  // 突破近 20 根高點
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  const breakoutHigh = closes[n - 1] >= high20 * 0.998; // 接近或突破
  const breakoutLow = closes[n - 1] <= low20 * 1.002; // 接近或跌破

  // ── 3. 價量配合判斷 ──
  let pvType = "neutral"; // 價量類型
  let pvScore = 50; // 基礎分

  // 核心: 價漲量增 = 最強
  if (priceChg3 > 0 && volRatio5 > 1.2) {
    pvType = "價漲量增";
    pvScore = 75;
    if (volExpanding) pvScore += 10; // 量持續放大
    if (breakoutHigh) pvScore += 10; // 突破高點
    if (volRatioNow > 2) pvScore += 5; // 爆量
  }
  // 價跌量縮 = 賣壓枯竭，反彈候選
  else if (priceChg3 < 0 && volRatio5 < 0.8) {
    pvType = "價跌量縮";
    pvScore = 65;
    if (volShrinking) pvScore += 5; // 量持續萎縮 = 賣壓更枯竭
    if (breakoutLow) pvScore -= 10; // 但如果破低就不妙
  }
  // 量能突破 (量暴增 > 2x 均量)
  else if (volRatioNow > 2 && priceChg3 > 0) {
    pvType = "量能突破";
    pvScore = 80;
    if (breakoutHigh) pvScore += 10;
  }
  // 價漲量縮 = 虛漲，迴避
  else if (priceChg3 > 0 && volRatio5 < 0.8) {
    pvType = "價漲量縮";
    pvScore = 30;
  }
  // 價跌量增 = 恐慌拋售
  else if (priceChg3 < 0 && volRatio5 > 1.2) {
    pvType = "價跌量增";
    pvScore = 20;
    if (volExpanding) pvScore -= 10;
  }
  // 量能突破但價跌 = 主力出貨
  else if (volRatioNow > 2 && priceChg3 < 0) {
    pvType = "放量下跌";
    pvScore = 15;
  }
  // 中性
  else {
    pvType = "中性盤整";
    pvScore = 45;
  }

  // ── 4. 加分項 ──
  // 中期趨勢加分
  if (priceChg10 > 3) pvScore += 5;
  else if (priceChg10 < -5) pvScore -= 5;

  // 波動率 (ATR% 衡量風險)
  let atrSum = 0;
  for (let i = n - 14; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    atrSum += tr;
  }
  const atr14 = atrSum / 14;
  const atrPct = closes[n - 1] > 0 ? (atr14 / closes[n - 1]) * 100 : 0;

  pvScore = Math.max(0, Math.min(100, Math.round(pvScore)));

  return {
    score: pvScore,
    pvType,
    volRatio5: Math.round(volRatio5 * 100) / 100,
    volRatioNow: Math.round(volRatioNow * 100) / 100,
    volExpanding,
    volShrinking,
    priceChg3: Math.round(priceChg3 * 100) / 100,
    priceChg10: Math.round(priceChg10 * 100) / 100,
    breakoutHigh,
    breakoutLow,
    atrPct: Math.round(atrPct * 100) / 100,
    high20: Math.round(high20 * 10000) / 10000,
    low20: Math.round(low20 * 10000) / 10000,
  };
}

// ── 主流程 ──
async function main() {
  const now = new Date();
  console.log(`\n=== OKX 價量掃描引擎 ===`);
  console.log(`時間: ${now.toISOString()}`);
  console.log(`類型: ${INST_TYPE} | Top: ${TOP_N}\n`);

  const tickers = await fetchAllTickers(INST_TYPE);
  console.log(`有效商品數: ${tickers.length} (過濾 24h 成交額 > $10,000)`);

  const topTickers = tickers.slice(0, TOP_N);
  console.log(`分析前 ${topTickers.length} 名...\n`);

  const results = [];
  for (const t of topTickers) {
    try {
      const candles = await fetchCandles(t.instId, "1H", 100);
      const pv = priceVolumeAnalysis(candles);
      results.push({
        instId: t.instId,
        last: t.last,
        chg24h: Math.round(t.chg24h * 100) / 100,
        volCcy24h: Math.round(t.volCcy24h),
        ...(pv || { score: 0, pvType: "資料不足" }),
      });
      await new Promise((r) => setTimeout(r, 80));
    } catch (e) {
      results.push({
        instId: t.instId,
        last: t.last,
        chg24h: Math.round(t.chg24h * 100) / 100,
        score: 0,
        pvType: `ERR: ${e.message.slice(0, 40)}`,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  const report = {
    schema: "openclaw.okx.market-scanner.v2",
    generatedAt: now.toISOString(),
    instType: INST_TYPE,
    totalInstruments: tickers.length,
    analyzed: results.length,
    methodology:
      "價量分析為核心：價漲量增(最強)→量能突破→價跌量縮(反彈)→中性→價漲量縮(虛漲)→價跌量增(恐慌)",
    topCandidates: results.filter((r) => r.score >= 65),
    allResults: results,
    disclaimer: "價量分析僅供研究參考，不構成投資建議。不保證獲利，交易有風險。",
    safety: { orderPlacementEnabled: false, liveTradingEnabled: false, readOnlyAnalysisOnly: true },
  };

  if (IS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      "排名 | 商品            | 價格        | 24h    | 分數 | 價量型態     | 量比5 | 當根量比 | 3根漲跌  | 突破 | ATR%",
    );
    console.log("─".repeat(115));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const brk = r.breakoutHigh ? "▲高" : r.breakoutLow ? "▼低" : "   ";
      console.log(
        `${String(i + 1).padStart(2)} | ${r.instId.padEnd(15)} | ` +
          `${String(r.last).padStart(11)} | ` +
          `${((r.chg24h > 0 ? "+" : "") + r.chg24h + "%").padStart(7)} | ` +
          `${String(r.score).padStart(3)}  | ` +
          `${(r.pvType || "?").padEnd(12)} | ` +
          `${String(r.volRatio5 || "-").padStart(5)} | ` +
          `${String(r.volRatioNow || "-").padStart(8)} | ` +
          `${((r.priceChg3 > 0 ? "+" : "") + (r.priceChg3 || 0) + "%").padStart(8)} | ` +
          `${brk} | ${r.atrPct || "-"}%`,
      );
    }
    const strong = results.filter((r) => r.score >= 65);
    console.log(`\n🔥 強勢候選 (≥65分): ${strong.length} 個`);
    for (const s of strong) {
      console.log(
        `  ${s.instId}: ${s.pvType} (${s.score}分) — 量比${s.volRatio5}x, 3根${s.priceChg3 > 0 ? "+" : ""}${s.priceChg3}%${s.breakoutHigh ? " ▲突破高點" : ""}`,
      );
    }
    console.log(`\n⚠️ 價量分析僅供研究參考，不構成投資建議。`);
  }

  if (WRITE_STATE) {
    await fs.mkdir(REPORT_DIR, { recursive: true });
    const rp = path.join(REPORT_DIR, "openclaw-okx-market-scanner-latest.json");
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
