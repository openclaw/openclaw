/**
 * Gate helpers for weak_model_regression_suite CI.
 * fail_rate > threshold (default 0.3) → gate fail (matches Playbook learn_if_high_fail).
 */

export const DEFAULT_FAIL_RATE_THRESHOLD = 0.3;

export function parseFailRate(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const n = Number.parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize regression_stats from Playbook run output (object or JSON string). */
export function normalizeRegressionStats(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function actualIntent(result) {
  if (!result || typeof result !== "object") {
    return "unknown";
  }
  return String(result.suggested_capability ?? result.intent ?? "unknown");
}

/** Deterministic scorer aligned with weak_model_regression_suite expectations. */
export function scoreIntentRegression(scenarios, intentResults, opts) {
  const simulateFailRate = opts?.simulateFailRate;
  if (simulateFailRate) {
    const rate = Number.parseFloat(simulateFailRate);
    if (Number.isFinite(rate)) {
      const total = scenarios.length;
      const fail = Math.round(rate * total);
      const pass = Math.max(0, total - fail);
      return {
        pass,
        fail,
        fail_rate: total > 0 ? fail / total : rate,
        details: ["simulated fail rate for CI gate test"],
      };
    }
  }

  let pass = 0;
  let fail = 0;
  const details = [];
  for (let i = 0; i < scenarios.length; i++) {
    const expected = String(scenarios[i]?.expected_intent ?? "");
    const actual = actualIntent(intentResults[i]);
    if (actual === expected) {
      pass += 1;
      details.push(`case ${i + 1}: pass (${actual})`);
    } else {
      fail += 1;
      details.push(`case ${i + 1}: fail expected=${expected} actual=${actual}`);
    }
  }
  const total = pass + fail;
  return {
    pass,
    fail,
    fail_rate: total > 0 ? fail / total : 0,
    details,
  };
}

export function evaluateRegressionGate(stats, threshold = DEFAULT_FAIL_RATE_THRESHOLD) {
  const normalized = normalizeRegressionStats(stats);
  const failRate = parseFailRate(normalized?.fail_rate ?? normalized?.failRate);
  if (failRate === null) {
    return {
      pass: false,
      reason: "missing_fail_rate",
      failRate: null,
      threshold,
      stats: normalized,
    };
  }
  if (failRate > threshold) {
    return {
      pass: false,
      reason: "fail_rate_exceeded",
      failRate,
      threshold,
      stats: normalized,
    };
  }
  return {
    pass: true,
    reason: "ok",
    failRate,
    threshold,
    stats: normalized,
  };
}
