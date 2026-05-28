/**
 * openclaw-capital-bar-accumulator.mjs
 *
 * 每日從 capital_quote_events.jsonl 提取 TX K 棒，
 * 累積儲存至 .openclaw/bars/TX-daily-bars.jsonl
 *
 * 功能：
 *   1. 讀取當前 tick 流，建立當日分鐘棒
 *   2. 追加到歷史棒資料庫（只追加新日期，不重複）
 *   3. 提供 loadBars() 供策略引擎使用
 *
 * Schema: openclaw.capital.bar-accumulator.v1
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { resolveCapitalStrategySymbol } from "./lib/capital-strategy-symbol-resolver.mjs";

const SCHEMA = "openclaw.capital.bar-accumulator.v1";

function toTWT(dateObj) {
  return new Date(dateObj.getTime() + 8 * 60 * 60 * 1000);
}

function twtDateStr(dateObj) {
  const d = toTWT(dateObj);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function twtHHMM(dateObj) {
  const d = toTWT(dateObj);
  return (
    String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0")
  );
}

function rawSummaryField(event, fieldName) {
  const rawSummary = String(event.rawSummary ?? "");
  const match = rawSummary.match(new RegExp(`${fieldName}=(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number.parseFloat(match[1]) : NaN;
}

function normalizeQuoteNumber(event, fieldName) {
  const value = Number.parseFloat(String(event[fieldName] ?? ""));
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const decimal = Number(event.decimal ?? 0);
  const factor = decimal > 0 ? 10 ** decimal : 1;
  const rawValue = rawSummaryField(event, fieldName);
  if (!Number.isFinite(rawValue) || factor <= 1) {
    return value;
  }

  const normalizedRaw = rawValue / factor;
  if (Math.abs(value - normalizedRaw) < 0.000001) {
    return value;
  }
  if (Math.abs(value - rawValue) < 0.000001) {
    return normalizedRaw;
  }
  return value >= 1_000_000 ? value / factor : value;
}

function fallbackSnapshotSymbolForQuery(query) {
  const normalized = String(query ?? "tx-front")
    .trim()
    .toUpperCase()
    .replace(/\s+/gu, "");
  if (
    ["TX-FRONT", "TX_FRONT", "TXFRONT", "TXF", "TXFR1", "TX00", "台指近", "台指期近"].includes(
      normalized,
    )
  ) {
    return "TX00";
  }
  return "";
}

function canUseHistoricalResolvedSymbol(resolvedSymbol) {
  return (
    Boolean(resolvedSymbol?.resolvedSymbol) &&
    !["invalid_legacy_session_alias", "missing_product_mapping"].includes(
      String(resolvedSymbol.status ?? ""),
    )
  );
}

/**
 * 從 tick 資料建立分鐘棒
 * @param {string[]} lines - JSONL 行
 * @param {string} symbol
 * @param {number} tfMin - 時間框架（分鐘）
 * @returns {object[]} 棒列表
 */
export function buildBarsFromTicks(lines, symbol, tfMin = 1) {
  const barMap = {};
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.stockNo !== symbol) {
      continue;
    }

    const close = normalizeQuoteNumber(event, "close");
    const bid = normalizeQuoteNumber(event, "bid");
    const ask = normalizeQuoteNumber(event, "ask");
    const qty = Number.parseInt(String(event.qty ?? ""), 10) || 0;
    if (!close || close <= 0) {
      continue;
    }

    const ts = new Date(event.receivedAt);
    const d = toTWT(ts);
    const twtMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const barMins = Math.floor(twtMins / tfMin) * tfMin;
    const barH = Math.floor(barMins / 60);
    const barM = barMins % 60;
    const dateStr = twtDateStr(ts);
    const timeStr = String(barH).padStart(2, "0") + ":" + String(barM).padStart(2, "0");
    const key = dateStr + "_" + timeStr;
    const hhmm = twtHHMM(ts);
    const inDay = hhmm >= "08:45" && hhmm <= "13:45";

    if (!barMap[key]) {
      barMap[key] = {
        symbol,
        date: dateStr,
        time: timeStr,
        inDaySession: inDay,
        open: close,
        high: close,
        low: close,
        close,
        bid,
        ask,
        volume: qty,
        ticks: 1,
        tsFirst: ts.toISOString(),
        tsLast: ts.toISOString(),
      };
    } else {
      const b = barMap[key];
      b.high = Math.max(b.high, close);
      b.low = Math.min(b.low, close);
      b.close = close;
      b.bid = bid;
      b.ask = ask;
      b.volume += qty;
      b.ticks += 1;
      b.tsLast = ts.toISOString();
    }
  }
  return Object.values(barMap).toSorted((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/**
 * 建立每日 OHLCV 摘要（從分鐘棒）
 */
export function buildDailySummary(symbol, date, minuteBars) {
  const dayBars = minuteBars.filter((b) => b.date === date && b.inDaySession);
  if (dayBars.length === 0) {
    return null;
  }
  return {
    symbol,
    date,
    open: dayBars[0].open,
    high: Math.max(...dayBars.map((b) => b.high)),
    low: Math.min(...dayBars.map((b) => b.low)),
    close: dayBars[dayBars.length - 1].close,
    volume: dayBars.reduce((s, b) => s + b.volume, 0),
    bars: dayBars.length,
    range: Math.max(...dayBars.map((b) => b.high)) - Math.min(...dayBars.map((b) => b.low)),
  };
}

/**
 * 載入已累積的歷史棒資料
 * @param {string} barsPath
 * @returns {Promise<object[]>}
 */
export async function loadAccumulatedBars(barsPath) {
  try {
    const raw = await fs.readFile(barsPath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter(Boolean);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * 主函式：累積今日棒資料
 */
export async function runBarAccumulator(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const tfMin = options.timeframeMinutes ?? 1;

  const hftStateDir = process.env.CAPITAL_HFT_STATE_DIR ?? resolveCapitalHftStateDir();
  const resolvedSymbol =
    options.resolveSymbol === false
      ? {
          ok: true,
          requestedSymbol: options.symbol ?? "TX00",
          resolvedSymbol: options.symbol ?? "TX00",
          status: "explicit_symbol",
          reason: "Symbol resolver disabled by caller.",
        }
      : await resolveCapitalStrategySymbol({
          query: options.symbol ?? "tx-front",
          repoRoot,
          stateDir: hftStateDir,
        }).catch((error) => ({
          ok: false,
          requestedSymbol: options.symbol ?? "tx-front",
          resolvedSymbol: fallbackSnapshotSymbolForQuery(options.symbol ?? "tx-front"),
          productId: "tx-front",
          status: "resolver_error",
          reason: `Symbol resolver failed; using historical snapshot fallback only. ${error instanceof Error ? error.message : String(error)}`,
          diagnostic: {
            blockerCode: "symbol_resolver_error",
            probableCause:
              "CapitalHftService state file was read while partially written or invalid.",
            unblockCondition: "Wait for the next complete state write, then rerun resolver.",
          },
          sourceStateDir: hftStateDir,
        }));
  const historicalFallbackAllowed = canUseHistoricalResolvedSymbol(resolvedSymbol);
  const symbol =
    resolvedSymbol.resolvedSymbol ||
    fallbackSnapshotSymbolForQuery(options.symbol ?? "tx-front") ||
    "TX00";
  const ticksPath = options.ticksPath ?? path.join(hftStateDir, "capital_quote_events.jsonl");

  const barsDir = path.join(repoRoot, ".openclaw", "bars");
  const barsPath = options.barsPath ?? path.join(barsDir, `${symbol}-1min-bars.jsonl`);
  const dailyPath = options.dailyPath ?? path.join(barsDir, `${symbol}-daily-summary.jsonl`);
  const generatedAt = new Date().toISOString();

  if (!resolvedSymbol.ok && !historicalFallbackAllowed) {
    return {
      schema: SCHEMA,
      generatedAt,
      status: "blocked_symbol_not_ready",
      readOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      symbol,
      resolver: resolvedSymbol,
      resolverReady: false,
      historicalFallbackUsed: false,
      newDates: [],
      totalBars: 0,
    };
  }

  // 讀取 tick 資料
  let rawLines = [];
  try {
    const raw = await fs.readFile(ticksPath, "utf8");
    rawLines = raw.split("\n").filter((l) => l.trim());
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        schema: SCHEMA,
        generatedAt,
        status: "no_ticks",
        readOnly: true,
        loginAttempted: false,
        liveTradingEnabled: false,
        writeTradingEnabled: false,
        brokerOrderPathEnabled: false,
        symbol,
        resolver: resolvedSymbol,
        resolverReady: resolvedSymbol.ok === true,
        historicalFallbackUsed: resolvedSymbol.ok !== true && historicalFallbackAllowed,
        newDates: [],
        totalBars: 0,
      };
    }
    throw err;
  }

  // 建立今日分鐘棒
  const todayBars = buildBarsFromTicks(rawLines, symbol, tfMin);
  const todayDates = [...new Set(todayBars.map((b) => b.date))];

  // 載入已累積棒（避免重複）
  const existingBars = await loadAccumulatedBars(barsPath);
  const existingKeys = new Set(existingBars.map((b) => b.date + "_" + b.time));

  // 只追加新的棒（今日及之前未記錄的）
  const newBars = todayBars.filter((b) => !existingKeys.has(b.date + "_" + b.time));

  await Promise.all([
    fs.mkdir(barsDir, { recursive: true }),
    fs.mkdir(path.dirname(barsPath), { recursive: true }),
    fs.mkdir(path.dirname(dailyPath), { recursive: true }),
  ]);
  if (newBars.length > 0) {
    await fs.appendFile(barsPath, newBars.map((b) => JSON.stringify(b)).join("\n") + "\n", "utf8");
  }

  // 更新每日摘要
  const existingDaily = await loadAccumulatedBars(dailyPath);
  const existingDailyDates = new Set(existingDaily.map((d) => d.date));
  const newDailySummaries = [];
  for (const date of todayDates) {
    if (!existingDailyDates.has(date)) {
      const summary = buildDailySummary(symbol, date, todayBars);
      if (summary) {
        newDailySummaries.push(summary);
        existingDailyDates.add(date);
      }
    }
  }
  if (newDailySummaries.length > 0) {
    await fs.appendFile(
      dailyPath,
      newDailySummaries.map((d) => JSON.stringify(d)).join("\n") + "\n",
      "utf8",
    );
  }

  const allBars = existingBars.length + newBars.length;
  const allDays = existingDaily.length + newDailySummaries.length;

  return {
    schema: SCHEMA,
    generatedAt,
    status: resolvedSymbol.ok ? "ok" : "ok_historical_snapshot",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    symbol,
    resolver: resolvedSymbol,
    resolverReady: resolvedSymbol.ok === true,
    historicalFallbackUsed: resolvedSymbol.ok !== true && historicalFallbackAllowed,
    ticksPath,
    newMinuteBars: newBars.length,
    newDailySummaries: newDailySummaries.length,
    totalMinuteBars: allBars,
    totalDays: allDays,
    newDates: [...new Set(newBars.map((b) => b.date))],
    barsPath,
    dailyPath,
    summary: newDailySummaries,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const result = await runBarAccumulator({
    repoRoot: flag("--repo-root"),
    symbol: flag("--symbol") ?? "tx-front",
    timeframeMinutes: Number(flag("--tf")) || 1,
    ticksPath: flag("--ticks-path"),
    barsPath: flag("--bars-path"),
    dailyPath: flag("--daily-path"),
  });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `status:          ${result.status}`,
        `symbol:          ${result.symbol}`,
        `resolverReady:   ${result.resolverReady}`,
        `snapshotMode:    ${result.historicalFallbackUsed}`,
        `newMinuteBars:   ${result.newMinuteBars}`,
        `totalMinuteBars: ${result.totalMinuteBars}`,
        `totalDays:       ${result.totalDays}`,
        `newDates:        ${result.newDates.join(", ") || "(無新日期)"}`,
        result.summary?.length > 0
          ? result.summary
              .map(
                (s) =>
                  `  ${s.date}: O=${s.open} H=${s.high} L=${s.low} C=${s.close} Range=${s.range.toFixed(0)}pts V=${s.volume}`,
              )
              .join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
