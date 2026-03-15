import type { GarminDailyMetrics, HrvDayAnalysis } from "./workout-types.js";

/** Mean and sample standard deviation. Returns null if fewer than 2 values. */
export function meanSd(values: number[]): { mean: number; sd: number } | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}

/**
 * Classify a value relative to a baseline band (mean +/- sd).
 * Returns status and band boundaries.
 */
export function classifyStatus(
  value: number | undefined,
  mean: number | undefined,
  sd: number | undefined,
): { status: string | null; low: number | null; high: number | null } {
  if (value === undefined || mean === undefined || sd === undefined) {
    return { status: null, low: null, high: null };
  }
  const low = mean - sd;
  const high = mean + sd;
  let status: string;
  if (value < low) {
    status = "suppressed";
  } else if (value > high) {
    status = "elevated";
  } else {
    status = "normal";
  }
  return { status, low, high };
}

/**
 * Determine trend direction based on percent change between two means.
 * Default threshold is 2%.
 */
export function trendDirection(
  oldMean: number | undefined,
  newMean: number | undefined,
  thresholdPct = 2.0,
): string {
  if (oldMean === undefined || newMean === undefined || oldMean === 0) return "stable";
  const changePct = ((newMean - oldMean) / Math.abs(oldMean)) * 100;
  if (changePct > thresholdPct) return "rising";
  if (changePct < -thresholdPct) return "declining";
  return "stable";
}

/**
 * Classify overall trend per Marco Altini methodology.
 * Uses HRV direction, RHR direction, and CV (coefficient of variation) direction.
 */
export function classifyTrend(hrvDir: string, rhrDir: string, cvDir: string): string {
  if (hrvDir === "declining" && rhrDir === "rising") return "accumulated_fatigue";
  if (rhrDir === "rising" && cvDir === "rising") return "maladaptation";
  if (
    (hrvDir === "rising" || hrvDir === "stable") &&
    (rhrDir === "stable" || rhrDir === "declining") &&
    (cvDir === "declining" || cvDir === "stable")
  ) {
    return "coping_well";
  }
  return "stable";
}

/**
 * Compute full HRV day analysis for a single date.
 *
 * Uses 7d moving average for HRV smoothing, 60d baseline for normal band,
 * 28d trend comparison, and consecutive suppressed day counting.
 */
export function computeHrvDay(
  targetDate: string,
  allGarmin: GarminDailyMetrics[],
  priorHrvAnalyses: HrvDayAnalysis[],
  hadWorkoutYesterday: boolean,
): HrvDayAnalysis {
  const todayGarmin = allGarmin.find((g) => g.date === targetDate);
  const hrvRaw = todayGarmin?.hrv;
  const rhrRaw = todayGarmin?.rhr;

  // 7d MA of HRV (inclusive of today, last 7 days)
  const hrv7dValues = allGarmin
    .filter(
      (g) => g.date <= targetDate && g.date > shiftDate(targetDate, -7) && g.hrv !== undefined,
    )
    .map((g) => g.hrv!);
  const hrv7dMa =
    hrv7dValues.length > 0
      ? hrv7dValues.reduce((a, b) => a + b, 0) / hrv7dValues.length
      : undefined;

  // 60d baseline for HRV (excludes today)
  const hrv60dValues = allGarmin
    .filter(
      (g) => g.date < targetDate && g.date >= shiftDate(targetDate, -60) && g.hrv !== undefined,
    )
    .map((g) => g.hrv!);
  const hrvBaseline = meanSd(hrv60dValues);

  // Classify HRV status based on 7d MA vs 60d baseline band
  const hrvClassification = classifyStatus(hrv7dMa, hrvBaseline?.mean, hrvBaseline?.sd);

  // HRV percent from baseline
  const hrvPctFromBaseline =
    hrv7dMa !== undefined && hrvBaseline?.mean
      ? ((hrv7dMa - hrvBaseline.mean) / hrvBaseline.mean) * 100
      : undefined;

  // 60d baseline for RHR (excludes today)
  const rhr60dValues = allGarmin
    .filter(
      (g) => g.date < targetDate && g.date >= shiftDate(targetDate, -60) && g.rhr !== undefined,
    )
    .map((g) => g.rhr!);
  const rhrBaseline = meanSd(rhr60dValues);

  // Classify RHR status (raw RHR vs baseline band)
  const rhrClassification = classifyStatus(rhrRaw, rhrBaseline?.mean, rhrBaseline?.sd);

  // CV of HRV over last 7 days (requires 3+ values)
  let hrvCv7d: number | undefined;
  if (hrv7dValues.length >= 3) {
    const stats = meanSd(hrv7dValues);
    if (stats && stats.mean > 0) {
      hrvCv7d = (stats.sd / stats.mean) * 100;
    }
  }

  // 28d trend: compare recent 28d mean vs prior 28d mean
  const recent28dHrv = valuesInRange(allGarmin, targetDate, -28, 0, "hrv");
  const prior28dHrv = valuesInRange(allGarmin, targetDate, -56, -28, "hrv");
  const recent28dRhr = valuesInRange(allGarmin, targetDate, -28, 0, "rhr");
  const prior28dRhr = valuesInRange(allGarmin, targetDate, -56, -28, "rhr");

  // CV trend: compute CV for recent 28d and prior 28d
  const recent28dCv = computeCv(recent28dHrv);
  const prior28dCv = computeCv(prior28dHrv);

  const hrvTrendDir = trendDirection(avg(prior28dHrv), avg(recent28dHrv));
  const rhrTrendDir = trendDirection(avg(prior28dRhr), avg(recent28dRhr));
  const cvTrendDir = trendDirection(prior28dCv, recent28dCv);

  const trend28d = classifyTrend(hrvTrendDir, rhrTrendDir, cvTrendDir);

  // Consecutive suppressed days
  let daysBelowHrvNormal = 0;
  if (hrvClassification.status === "suppressed") {
    daysBelowHrvNormal = 1;
    // Count from prior analyses
    for (let i = priorHrvAnalyses.length - 1; i >= 0; i--) {
      if (priorHrvAnalyses[i]!.hrvStatus === "suppressed") {
        daysBelowHrvNormal++;
      } else {
        break;
      }
    }
  }

  return {
    date: targetDate,
    hrvRaw,
    rhrRaw,
    hrv7dMa,
    hrvBaseline60d: hrvBaseline?.mean,
    hrvSd60d: hrvBaseline?.sd,
    hrvNormalLow: hrvClassification.low ?? undefined,
    hrvNormalHigh: hrvClassification.high ?? undefined,
    hrvStatus: hrvClassification.status ?? undefined,
    hrvPctFromBaseline,
    rhrBaseline60d: rhrBaseline?.mean,
    rhrSd60d: rhrBaseline?.sd,
    rhrNormalLow: rhrClassification.low ?? undefined,
    rhrNormalHigh: rhrClassification.high ?? undefined,
    rhrStatus: rhrClassification.status ?? undefined,
    hrvCv7d,
    trend28d,
    hrvTrendDirection: hrvTrendDir,
    rhrTrendDirection: rhrTrendDir,
    cvTrendDirection: cvTrendDir,
    daysBelowHrvNormal,
    postWorkout: hadWorkoutYesterday,
  };
}

/**
 * Compute HRV analysis for all dates in garminData, in chronological order.
 * Each day builds on the prior analyses.
 */
export function computeHrvRange(
  garminData: GarminDailyMetrics[],
  sessionDates: Set<string>,
): HrvDayAnalysis[] {
  const sorted = [...garminData].sort((a, b) => a.date.localeCompare(b.date));
  const analyses: HrvDayAnalysis[] = [];

  for (const garmin of sorted) {
    // Check if yesterday had a workout
    const yesterday = shiftDate(garmin.date, -1);
    const hadWorkoutYesterday = sessionDates.has(yesterday);

    const analysis = computeHrvDay(garmin.date, sorted, analyses, hadWorkoutYesterday);
    analyses.push(analysis);
  }

  return analyses;
}

// --- helpers ---

/** Shift a YYYY-MM-DD date string by a number of days. */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Extract numeric values for a metric within a date range (exclusive start, inclusive end). */
function valuesInRange(
  garmin: GarminDailyMetrics[],
  anchor: string,
  startDaysAgo: number,
  endDaysAgo: number,
  metric: "hrv" | "rhr",
): number[] {
  const startDate = shiftDate(anchor, startDaysAgo);
  const endDate = shiftDate(anchor, endDaysAgo);
  return garmin
    .filter((g) => g.date > startDate && g.date <= endDate && g[metric] !== undefined)
    .map((g) => g[metric]!);
}

/** Compute coefficient of variation from an array of numbers. */
function computeCv(values: number[]): number | undefined {
  const stats = meanSd(values);
  if (!stats || stats.mean === 0) return undefined;
  return (stats.sd / stats.mean) * 100;
}

/** Average of numeric array. Returns undefined if empty. */
function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
