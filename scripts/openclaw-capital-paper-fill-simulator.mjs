/**
 * openclaw-capital-paper-fill-simulator.mjs
 *
 * 讀取 capital-paper-intents.jsonl，模擬每筆 intent 是否成交，計算損益統計。
 * 成交率模型：index % 100 < 49（48.9% 成交率）
 *
 * 安全約束：
 *   allowLiveTrading: false（絕不設為 true）
 *   writeBrokerOrders: false（絕不設為 true）
 *   promoteLiveAutomatically: false（絕不設為 true）
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.paper-fill-simulation.v1";
const DEFAULT_MONTE_CARLO_ITERATIONS = 500;
const INVALID_LEGACY_SYMBOLS = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function calcStddev(values, mean) {
  if (values.length === 0) {
    return 0;
  }
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function deterministicUnit(...parts) {
  const hex = crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function canonicalSymbol(symbol) {
  return String(symbol ?? "")
    .trim()
    .toUpperCase();
}

function normalizeIntent(intent) {
  const originalSymbol = String(intent?.symbol ?? "")
    .trim()
    .toUpperCase();
  const symbol = canonicalSymbol(intent?.symbol);
  return {
    ...intent,
    symbol,
    legacySymbolBlocked: INVALID_LEGACY_SYMBOLS.has(originalSymbol),
    legacySymbolNormalized: false,
  };
}

function isUnsafeIntent(intent) {
  return (
    intent?.allowLiveTrading === true ||
    intent?.liveTradingEnabled === true ||
    intent?.writeBrokerOrders === true ||
    intent?.writeTradingEnabled === true ||
    intent?.brokerOrderPathEnabled === true ||
    intent?.promoteLiveAuto === true ||
    intent?.promoteLiveAutomatically === true
  );
}

function digestIntentLines(lines) {
  const normalized = lines.map((line) => line.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }
  return sha256Text(`${normalized.join("\n")}\n`);
}

function uniqueIntentRunIds(intents) {
  return [
    ...new Set(
      intents
        .map((intent) => String(intent?.intentRunId ?? "").trim())
        .filter((intentRunId) => intentRunId.length > 0),
    ),
  ].sort();
}

async function readIntentSource(
  primaryPath,
  generatedCurrentIntentsPath,
  fallbackLatestPath,
  options = {},
) {
  async function readPrimaryJsonl() {
    try {
      const raw = await fs.readFile(primaryPath, "utf8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { exists: true, lines };
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { exists: false, lines: [] };
      }
      throw err;
    }
  }

  async function readJsonlIfNonEmpty(filePath) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { exists: true, lines };
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { exists: false, lines: [] };
      }
      throw err;
    }
  }

  const generatedCurrent = await readJsonlIfNonEmpty(generatedCurrentIntentsPath);
  if (options.preferGeneratedCurrent === true && generatedCurrent.lines.length > 0) {
    return {
      lines: generatedCurrent.lines,
      path: generatedCurrentIntentsPath,
      fallbackUsed: false,
      fallbackReason: "generated_current_preferred",
    };
  }
  const primary = await readPrimaryJsonl();
  if (primary.lines.length > 0) {
    return { lines: primary.lines, path: primaryPath, fallbackUsed: false, fallbackReason: "" };
  }
  if (generatedCurrent.lines.length > 0) {
    return {
      lines: generatedCurrent.lines,
      path: generatedCurrentIntentsPath,
      fallbackUsed: true,
      fallbackReason: primary.exists
        ? "primary_empty_generated_current"
        : "primary_missing_generated_current",
    };
  }
  if (primary.exists) {
    return {
      lines: [],
      path: primaryPath,
      fallbackUsed: false,
      fallbackReason: "primary_empty",
    };
  }

  try {
    const raw = await fs.readFile(fallbackLatestPath, "utf8");
    const latest = JSON.parse(raw);
    return {
      lines: [JSON.stringify(latest)],
      path: fallbackLatestPath,
      fallbackUsed: true,
      fallbackReason: primary.exists ? "primary_empty" : "primary_missing",
    };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }

  return {
    lines: [],
    path: primaryPath,
    fallbackUsed: false,
    fallbackReason: primary.exists ? "primary_empty" : "primary_missing",
  };
}

function simulateIntent(intent, index, iteration = 0) {
  const entryPrice = Number(intent.price ?? intent.entryPrice ?? 0);
  const ev = intent.sourceEvent ?? {};
  const bid = Number(ev.bid ?? entryPrice);
  const ask = Number(ev.ask ?? bid + 1);
  const spread = Math.max(1, ask - bid);
  const fillUnit =
    iteration === 0
      ? index / 100
      : deterministicUnit(intent.intentId, intent.symbol, index, iteration, "fill");
  const isFilled = fillUnit < 0.49;

  if (!isFilled) {
    return { filled: false, pnl: 0, win: false };
  }

  const close = Number(ev.close ?? entryPrice);
  const isWin = close > bid;
  const pnl = isWin ? spread : -Math.round(spread * 0.5);
  return { filled: true, pnl, win: isWin };
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * ratio)),
  );
  return sortedValues[index];
}

function runMonteCarlo(intents, iterations) {
  const totals = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < intents.length; index += 1) {
      total += simulateIntent(intents[index], index, iteration + 1).pnl;
    }
    totals.push(Math.round(total * 10) / 10);
  }
  const sorted = totals.toSorted((a, b) => a - b);
  const positiveCount = totals.filter((value) => value > 0).length;
  return {
    iterations,
    p05_total_pnl_ticks: percentile(sorted, 0.05),
    p50_total_pnl_ticks: percentile(sorted, 0.5),
    p95_total_pnl_ticks: percentile(sorted, 0.95),
    positive_rate: iterations > 0 ? Math.round((positiveCount / iterations) * 10000) / 10000 : 0,
    worst_total_pnl_ticks: sorted[0] ?? 0,
    best_total_pnl_ticks: sorted.at(-1) ?? 0,
  };
}

/**
 * 執行 paper fill 模擬。
 * @param {object} options
 * @param {string} [options.repoRoot]
 * @param {string} [options.intentsPath]
 * @param {string} [options.outputPath]
 */
export async function runCapitalPaperFillSimulation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const intentsPath = options.intentsPath
    ? path.resolve(options.intentsPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-intents.jsonl");
  const fallbackLatestPath = options.fallbackLatestPath
    ? path.resolve(options.fallbackLatestPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-intent-latest.json");
  const generatedCurrentIntentsPath = options.generatedCurrentIntentsPath
    ? path.resolve(options.generatedCurrentIntentsPath)
    : path.join(
        repoRoot,
        ".openclaw",
        "trading",
        "capital-current-paper-intents-from-target-registry.jsonl",
      );
  const outputPath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(repoRoot, ".openclaw", "trading", "capital-paper-fill-simulation.json");
  const monteCarloIterations = Number.isFinite(Number(options.monteCarloIterations))
    ? Math.max(1, Math.floor(Number(options.monteCarloIterations)))
    : DEFAULT_MONTE_CARLO_ITERATIONS;
  const generatedAt = new Date().toISOString();

  const source = await readIntentSource(
    intentsPath,
    generatedCurrentIntentsPath,
    fallbackLatestPath,
    { preferGeneratedCurrent: !options.intentsPath },
  );
  const lines = source.lines;
  const sourceDigest = digestIntentLines(lines);
  const baseSafety = {
    allowLiveTrading: false,
    writeBrokerOrders: false,
    promoteLiveAutomatically: false,
  };
  const emptyStats = {
    total_intents: 0,
    filled_count: 0,
    fill_rate: 0,
    total_pnl_ticks: 0,
    avg_pnl_ticks: 0,
    sharpe_proxy: 0,
    win_streak_max: 0,
    loss_streak_max: 0,
    invalid_intent_count: 0,
    unsafe_intent_count: 0,
    normalized_legacy_alias_count: 0,
  };
  if (lines.length === 0) {
    const report = {
      schema: SCHEMA,
      generatedAt,
      status: "no_intents",
      readOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      strategyName: "capital-paper-microstructure-probe",
      signalPolicy: "passive_bid_probe",
      source: {
        intentsPath,
        generatedCurrentIntentsPath,
        fallbackLatestPath,
        actualPath: source.path,
        fallbackUsed: false,
        fallbackReason: source.fallbackReason,
        sourceRecordCount: 0,
        sourceDigest: "",
        intentRunIds: [],
      },
      stats: emptyStats,
      summary: emptyStats,
      monteCarlo: runMonteCarlo([], monteCarloIterations),
      safetyLock: baseSafety,
    };
    await writeJsonWithSha(outputPath, report);
    return report;
  }

  const pnlValues = [];
  let filled_count = 0;
  let win_streak = 0;
  let loss_streak = 0;
  let win_streak_max = 0;
  let loss_streak_max = 0;
  let invalidIntentCount = 0;
  let unsafeIntentCount = 0;
  let blockedLegacyAliasCount = 0;
  let normalizedLegacyAliasCount = 0;
  const parsedIntents = [];

  for (let index = 0; index < lines.length; index++) {
    let intent;
    try {
      intent = normalizeIntent(JSON.parse(lines[index]));
    } catch {
      invalidIntentCount += 1;
      continue;
    }
    if (intent.legacySymbolBlocked) {
      blockedLegacyAliasCount += 1;
      continue;
    }
    if (intent.legacySymbolNormalized) {
      normalizedLegacyAliasCount += 1;
    }
    if (isUnsafeIntent(intent)) {
      unsafeIntentCount += 1;
      continue;
    }
    parsedIntents.push(intent);

    const simulated = simulateIntent(intent, parsedIntents.length - 1);

    if (simulated.filled) {
      pnlValues.push(simulated.pnl);
      filled_count += 1;
      if (simulated.win) {
        // 成交獲利：結束連敗，開始連勝
        loss_streak_max = Math.max(loss_streak_max, loss_streak);
        loss_streak = 0;
        win_streak += 1;
        win_streak_max = Math.max(win_streak_max, win_streak);
      } else {
        // 成交虧損：結束連勝，開始連敗
        win_streak_max = Math.max(win_streak_max, win_streak);
        win_streak = 0;
        loss_streak += 1;
        loss_streak_max = Math.max(loss_streak_max, loss_streak);
      }
    } else {
      // 未成交 = 中性，不計入連勝/連敗（passive bid 超時是正常行為）
      pnlValues.push(0);
    }
  }

  // 尾端 streak 補齊
  win_streak_max = Math.max(win_streak_max, win_streak);
  loss_streak_max = Math.max(loss_streak_max, loss_streak);

  const total_intents = pnlValues.length;
  const total_pnl_ticks = Math.round(pnlValues.reduce((s, v) => s + v, 0) * 10) / 10;
  const avg_pnl_ticks =
    total_intents > 0 ? Math.round((total_pnl_ticks / total_intents) * 1000) / 1000 : 0;
  const fill_rate =
    total_intents > 0 ? Math.round((filled_count / total_intents) * 10000) / 10000 : 0;
  const stddev = calcStddev(pnlValues, avg_pnl_ticks);
  const sharpe_proxy = stddev > 0 ? Math.round((avg_pnl_ticks / stddev) * 10000) / 10000 : 0;

  const stats = {
    total_intents,
    filled_count,
    fill_rate,
    total_pnl_ticks,
    avg_pnl_ticks,
    sharpe_proxy,
    win_streak_max,
    loss_streak_max,
    invalid_intent_count: invalidIntentCount,
    unsafe_intent_count: unsafeIntentCount,
    blocked_legacy_alias_count: blockedLegacyAliasCount,
    normalized_legacy_alias_count: normalizedLegacyAliasCount,
  };

  const report = {
    schema: SCHEMA,
    generatedAt,
    status: parsedIntents.length > 0 ? "ok" : "no_safe_intents",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    strategyName:
      parsedIntents[0]?.strategyName ??
      parsedIntents[0]?.strategy ??
      "capital-paper-microstructure-probe",
    signalPolicy: "passive_bid_probe",
    source: {
      intentsPath,
      generatedCurrentIntentsPath,
      fallbackLatestPath,
      actualPath: source.path,
      fallbackUsed: source.fallbackUsed,
      fallbackReason: source.fallbackReason,
      sourceRecordCount: lines.length,
      sourceDigest,
      intentRunIds: uniqueIntentRunIds(parsedIntents),
    },
    stats,
    summary: stats,
    monteCarlo: runMonteCarlo(parsedIntents, monteCarloIterations),
    safetyLock: baseSafety,
  };
  await writeJsonWithSha(outputPath, report);
  return report;
}

// --- CLI 入口 ---
async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }
  const repoRoot = flag("--repo-root");
  const intentsPath = flag("--intents-path");
  const outputPath = flag("--output-path");
  const jsonMode = args.includes("--json");

  const result = await runCapitalPaperFillSimulation({
    repoRoot,
    intentsPath,
    outputPath,
  });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const s = result.stats;
    process.stdout.write(
      [
        `schema:          ${result.schema}`,
        `generatedAt:     ${result.generatedAt}`,
        `status:          ${result.status}`,
        `total_intents:   ${s.total_intents}`,
        `filled_count:    ${s.filled_count}`,
        `fill_rate:       ${s.fill_rate}`,
        `total_pnl_ticks: ${s.total_pnl_ticks}`,
        `avg_pnl_ticks:   ${s.avg_pnl_ticks}`,
        `sharpe_proxy:    ${s.sharpe_proxy}`,
        `win_streak_max:  ${s.win_streak_max}`,
        `loss_streak_max: ${s.loss_streak_max}`,
      ].join("\n") + "\n",
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
