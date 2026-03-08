import type { DecayEstimate } from "./types.js";

/**
 * Estimate alpha decay by fitting OLS regression on ln(rollingSharpe) vs time.
 * ln(S_t) = a - lambda * t  =>  halfLife = ln(2) / lambda
 */
export function estimateAlphaDecay(rollingSharpes: number[]): DecayEstimate {
  // Filter to positive Sharpes (can't take ln of non-positive)
  const points: Array<{ t: number; lnS: number }> = [];
  for (let i = 0; i < rollingSharpes.length; i++) {
    if (rollingSharpes[i] > 0) {
      points.push({ t: i, lnS: Math.log(rollingSharpes[i]) });
    }
  }

  if (points.length < 5) {
    return { halfLifeDays: Infinity, decayRate: 0, r2: 0, classification: "stable" };
  }

  // OLS: y = a + b*x  where y = lnS, x = t
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.t, 0);
  const sumY = points.reduce((s, p) => s + p.lnS, 0);
  const sumXY = points.reduce((s, p) => s + p.t * p.lnS, 0);
  const sumX2 = points.reduce((s, p) => s + p.t * p.t, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) {
    return { halfLifeDays: Infinity, decayRate: 0, r2: 0, classification: "stable" };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // lambda = -slope (we expect negative slope for decay)
  const lambda = -slope;

  // R-squared
  const meanY = sumY / n;
  const ssTot = points.reduce((s, p) => s + (p.lnS - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.lnS - (intercept + slope * p.t)) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  const halfLifeDays = lambda > 0 ? Math.LN2 / lambda : Infinity;

  let classification: DecayEstimate["classification"];
  if (halfLifeDays > 90 || halfLifeDays === Infinity) {
    classification = "stable";
  } else if (halfLifeDays > 30) {
    classification = "slow-decay";
  } else {
    classification = "fast-decay";
  }

  return { halfLifeDays, decayRate: lambda, r2, classification };
}
