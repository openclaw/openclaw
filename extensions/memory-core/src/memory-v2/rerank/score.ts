import {
  RERANK_DEFAULTS,
  type RerankConfig,
  type RerankSignals,
  type RerankableResult,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Pure scoring step. Returns a new array of new objects so callers cannot
// accidentally observe in-place mutation of the upstream search results.
// Identity behavior when `signalsByLocation` is empty: every multiplier is
// exactly 1, so per-result scores are byte-identical to the input.
export function applyRerank<T extends RerankableResult>(params: {
  results: readonly T[];
  signalsByLocation: ReadonlyMap<string, RerankSignals>;
  locationIdOf: (result: T) => string;
  cfg?: RerankConfig;
  now: number;
}): T[] {
  const cfg = mergeDefaults(params.cfg);
  return params.results.map((r) => {
    const signals = params.signalsByLocation.get(params.locationIdOf(r));
    const newScore = signals ? rescore(r.score, signals, cfg, params.now) : r.score;
    return { ...r, score: newScore };
  });
}

export function rescore(
  baseScore: number,
  signals: RerankSignals,
  cfg: Required<RerankConfig>,
  now: number,
): number {
  const salience01 = signals.salience ?? cfg.defaultSalience;
  const salienceMul = 1 + cfg.salienceWeight * salience01;
  const recencyMul = recencyMultiplier(signals.lastAccessedAt, cfg, now);
  const pinnedMul = signals.pinned ? 1 + cfg.pinnedBoost : 1;
  const statusMul = signals.status === "superseded" ? 1 - cfg.supersededPenalty : 1;
  return baseScore * salienceMul * recencyMul * pinnedMul * statusMul;
}

export function recencyMultiplier(
  lastAccessedAt: number | null,
  cfg: Required<RerankConfig>,
  now: number,
): number {
  if (lastAccessedAt === null) {
    return 1;
  }
  if (cfg.recencyHalfLifeDays <= 0) {
    return 1;
  }
  const ageDays = Math.max(0, (now - lastAccessedAt) / DAY_MS);
  const raw = 0.5 ** (ageDays / cfg.recencyHalfLifeDays);
  return Math.max(cfg.recencyFloor, raw);
}

export function mergeDefaults(cfg: RerankConfig | undefined): Required<RerankConfig> {
  return {
    salienceWeight: cfg?.salienceWeight ?? RERANK_DEFAULTS.salienceWeight,
    recencyHalfLifeDays: cfg?.recencyHalfLifeDays ?? RERANK_DEFAULTS.recencyHalfLifeDays,
    pinnedBoost: cfg?.pinnedBoost ?? RERANK_DEFAULTS.pinnedBoost,
    supersededPenalty: cfg?.supersededPenalty ?? RERANK_DEFAULTS.supersededPenalty,
    recencyFloor: cfg?.recencyFloor ?? RERANK_DEFAULTS.recencyFloor,
    defaultSalience: cfg?.defaultSalience ?? RERANK_DEFAULTS.defaultSalience,
  };
}
