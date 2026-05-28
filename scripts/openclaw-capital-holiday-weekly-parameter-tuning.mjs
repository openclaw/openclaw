import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalHolidayWeeklyFeedbackBridge } from "./openclaw-capital-holiday-weekly-feedback-bridge.mjs";
import { runCapitalHolidayWeeklySimulation } from "./openclaw-capital-holiday-weekly-simulation.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");

const DEFAULT_PARAMS_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-params-latest.json",
);
const DEFAULT_WEEKLY_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-simulation-latest.json",
);
const DEFAULT_DMAD_PATH = path.join(repoRoot, "reports", "dmad-run-test-latest.json");
const DEFAULT_BRIDGE_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-feedback-latest.json",
);
const DEFAULT_TUNING_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-holiday-weekly-parameter-tuning-latest.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max) {
  return Math.floor(clampNumber(value, min, max));
}

function round3(value) {
  return Number(asNumber(value, 0).toFixed(3));
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pickStrategyConfig(weekly, key, fallback) {
  const raw = weekly?.strategies?.[key]?.config;
  return raw && typeof raw === "object" ? raw : fallback;
}

function buildBaseParams(existingParams, weekly) {
  const fallbackBreakout = {
    lookbackBars: 30,
    volumeLookbackBars: 40,
    volumeZThreshold: 1.2,
    breakoutThresholdPct: 0.04,
    takeProfitPct: 0.2,
    stopLossPct: 0.12,
    maxHoldBars: 20,
  };
  const fallbackVwap = {
    volumeLookbackBars: 50,
    volumeZThreshold: 0.8,
    vwapDeviationPct: 0.15,
    stopLossPct: 0.1,
    maxHoldBars: 30,
  };
  const fromExisting = existingParams?.strategies && typeof existingParams.strategies === "object";
  const breakout = fromExisting
    ? existingParams.strategies.volume_breakout
    : pickStrategyConfig(weekly, "volume_breakout", fallbackBreakout);
  const vwap = fromExisting
    ? existingParams.strategies.vwap_reversion
    : pickStrategyConfig(weekly, "vwap_reversion", fallbackVwap);
  return {
    volume_breakout: {
      lookbackBars: clampInt(
        asNumber(breakout?.lookbackBars, fallbackBreakout.lookbackBars),
        10,
        120,
      ),
      volumeLookbackBars: clampInt(
        asNumber(breakout?.volumeLookbackBars, fallbackBreakout.volumeLookbackBars),
        20,
        200,
      ),
      volumeZThreshold: round3(
        clampNumber(
          asNumber(breakout?.volumeZThreshold, fallbackBreakout.volumeZThreshold),
          0.2,
          5.0,
        ),
      ),
      breakoutThresholdPct: round3(
        clampNumber(
          asNumber(breakout?.breakoutThresholdPct, fallbackBreakout.breakoutThresholdPct),
          0.01,
          1.5,
        ),
      ),
      takeProfitPct: round3(
        clampNumber(asNumber(breakout?.takeProfitPct, fallbackBreakout.takeProfitPct), 0.02, 3.0),
      ),
      stopLossPct: round3(
        clampNumber(asNumber(breakout?.stopLossPct, fallbackBreakout.stopLossPct), 0.02, 2.0),
      ),
      maxHoldBars: clampInt(asNumber(breakout?.maxHoldBars, fallbackBreakout.maxHoldBars), 3, 300),
    },
    vwap_reversion: {
      volumeLookbackBars: clampInt(
        asNumber(vwap?.volumeLookbackBars, fallbackVwap.volumeLookbackBars),
        20,
        200,
      ),
      volumeZThreshold: round3(
        clampNumber(asNumber(vwap?.volumeZThreshold, fallbackVwap.volumeZThreshold), 0.2, 5.0),
      ),
      vwapDeviationPct: round3(
        clampNumber(asNumber(vwap?.vwapDeviationPct, fallbackVwap.vwapDeviationPct), 0.03, 2.0),
      ),
      stopLossPct: round3(
        clampNumber(asNumber(vwap?.stopLossPct, fallbackVwap.stopLossPct), 0.02, 2.0),
      ),
      maxHoldBars: clampInt(asNumber(vwap?.maxHoldBars, fallbackVwap.maxHoldBars), 3, 300),
    },
  };
}

function applyTuning(baseParams, bestStrategy, bestPnlPts) {
  const tuned = JSON.parse(JSON.stringify(baseParams));
  const changes = [];
  const positive = asNumber(bestPnlPts, 0) > 0;

  if (bestStrategy === "vwap_reversion") {
    const prev = tuned.vwap_reversion;
    tuned.vwap_reversion.volumeZThreshold = round3(
      clampNumber(prev.volumeZThreshold + (positive ? 0.05 : 0.1), 0.2, 5.0),
    );
    tuned.vwap_reversion.vwapDeviationPct = round3(
      clampNumber(prev.vwapDeviationPct + (positive ? -0.01 : 0.01), 0.03, 2.0),
    );
    tuned.vwap_reversion.stopLossPct = round3(
      clampNumber(prev.stopLossPct + (positive ? -0.005 : 0.01), 0.02, 2.0),
    );
    tuned.vwap_reversion.maxHoldBars = clampInt(prev.maxHoldBars + (positive ? -2 : 2), 3, 300);
    changes.push({
      strategy: "vwap_reversion",
      reason: positive
        ? "best_strategy_positive_pnl_fine_tune"
        : "best_strategy_nonpositive_pnl_defensive_tune",
      before: prev,
      after: tuned.vwap_reversion,
    });
  } else if (bestStrategy === "volume_breakout") {
    const prev = tuned.volume_breakout;
    tuned.volume_breakout.volumeZThreshold = round3(
      clampNumber(prev.volumeZThreshold + (positive ? 0.03 : 0.08), 0.2, 5.0),
    );
    tuned.volume_breakout.breakoutThresholdPct = round3(
      clampNumber(prev.breakoutThresholdPct + (positive ? -0.003 : 0.005), 0.01, 1.5),
    );
    tuned.volume_breakout.stopLossPct = round3(
      clampNumber(prev.stopLossPct + (positive ? -0.005 : 0.01), 0.02, 2.0),
    );
    tuned.volume_breakout.maxHoldBars = clampInt(prev.maxHoldBars + (positive ? -2 : 2), 3, 300);
    changes.push({
      strategy: "volume_breakout",
      reason: positive
        ? "best_strategy_positive_pnl_fine_tune"
        : "best_strategy_nonpositive_pnl_defensive_tune",
      before: prev,
      after: tuned.volume_breakout,
    });
  } else {
    changes.push({
      strategy: "none",
      reason: "best_strategy_unknown_no_change",
      before: null,
      after: null,
    });
  }

  return { tuned, changes };
}

export async function runCapitalHolidayWeeklyParameterTuning(options = {}) {
  const paramsPath = path.resolve(options.paramsPath || DEFAULT_PARAMS_PATH);
  const weeklyPath = path.resolve(options.weeklyPath || DEFAULT_WEEKLY_PATH);
  const dmadPath = path.resolve(options.dmadPath || DEFAULT_DMAD_PATH);
  const bridgePath = path.resolve(options.bridgePath || DEFAULT_BRIDGE_PATH);
  const tuningReportPath = path.resolve(options.tuningReportPath || DEFAULT_TUNING_REPORT_PATH);

  const weekly = await readJson(weeklyPath);
  const dmad = await readJson(dmadPath);
  const bridge = await readJson(bridgePath);
  const existingParams = await readJsonIfExists(paramsPath);

  const bestStrategy = String(weekly?.ranking?.[0]?.strategy ?? "");
  const bestPnlPts = asNumber(weekly?.ranking?.[0]?.totalPnlPts, 0);
  const baseParams = buildBaseParams(existingParams, weekly);
  const readyForTuning = String(bridge?.status ?? "") === "ready_for_parameter_tuning";
  const dmadPass =
    String(dmad?.qualityStatus ?? "") === "pass" && !String(dmad?.degradedReason ?? "");

  const { tuned, changes } = applyTuning(baseParams, bestStrategy, bestPnlPts);
  const paramsPayload = {
    schema: "openclaw.capital.holiday-weekly-params.v1",
    generatedAt: new Date().toISOString(),
    source: {
      weeklyPath,
      dmadPath,
      bridgePath,
      bridgeStatus: String(bridge?.status ?? ""),
      dmadQualityStatus: String(dmad?.qualityStatus ?? ""),
    },
    strategies: readyForTuning && dmadPass ? tuned : baseParams,
  };

  let weeklyResult = null;
  let bridgeResult = null;
  let status = "blocked_not_ready_for_tuning";

  if (readyForTuning && dmadPass) {
    status = "tuned_and_resimulated";
    if (options.writeState === true) {
      await writeJson(paramsPath, paramsPayload);
    }
    weeklyResult = await runCapitalHolidayWeeklySimulation({
      paramsPath,
      weeklyPath,
      outputPath: weeklyPath,
      writeState: options.writeState === true,
      lookbackDays: 7,
    });
    bridgeResult = await runCapitalHolidayWeeklyFeedbackBridge({
      weeklyPath,
      dmadPath,
      writeState: options.writeState === true,
    });
  } else {
    changes.splice(0, changes.length, {
      strategy: "none",
      reason: `skip_tuning_bridge=${bridge?.status ?? "unknown"}_dmad=${dmad?.qualityStatus ?? "unknown"}`,
      before: null,
      after: null,
    });
  }

  const report = {
    schema: "openclaw.capital.holiday-weekly-parameter-tuning.v1",
    generatedAt: new Date().toISOString(),
    status,
    bestStrategy,
    bestPnlPts,
    readyForTuning,
    dmadPass,
    paramsPath,
    weeklyPath,
    dmadPath,
    bridgePath,
    changes,
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      paperOnly: true,
    },
    postRun: {
      weeklyStatus: String(weeklyResult?.report?.status ?? ""),
      bridgeStatus: String(bridgeResult?.report?.status ?? bridge?.status ?? ""),
      bridgeBlockerCode: String(bridgeResult?.report?.blockerCode ?? bridge?.blockerCode ?? ""),
    },
    nextSafeTask:
      status === "tuned_and_resimulated"
        ? "比較調參前後 weekly ranking 與 maxDrawdown，若改善則固化參數並建立 promotion gate。"
        : "先讓 bridge status=ready_for_parameter_tuning 且 dmad quality=pass，再執行參數回寫。",
  };

  if (options.writeState === true) {
    await writeJson(tuningReportPath, report);
    if (!(readyForTuning && dmadPass)) {
      await writeJson(paramsPath, paramsPayload);
    }
  }

  return {
    report,
    tuningReportPath,
    paramsPath,
    weeklyPath,
    bridgePath,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalHolidayWeeklyParameterTuning({
    paramsPath: argValue("--params", DEFAULT_PARAMS_PATH),
    weeklyPath: argValue("--weekly", DEFAULT_WEEKLY_PATH),
    dmadPath: argValue("--dmad", DEFAULT_DMAD_PATH),
    bridgePath: argValue("--bridge", DEFAULT_BRIDGE_PATH),
    tuningReportPath: argValue("--report", DEFAULT_TUNING_REPORT_PATH),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital holiday weekly parameter tuning",
        `status=${result.report.status}`,
        `bestStrategy=${result.report.bestStrategy || "none"}`,
        `bestPnlPts=${result.report.bestPnlPts}`,
        `bridgeStatus=${result.report.postRun.bridgeStatus || "unknown"}`,
        "live/write/order=OFF",
      ].join("\n") + "\n",
    );
  }
}
