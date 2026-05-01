import fs from "node:fs/promises";
import path from "node:path";

/**
 * Decay model for temporal scoring.
 *
 * - "exponential" (default, legacy): `multiplier = exp(-ln2 * t / halfLife)`.
 *   Constant hazard rate; matches the behavior that shipped before this option
 *   existed. Kept as default so existing deployments are bit-for-bit unchanged.
 *
 * - "weibull": stretched-exponential form
 *   `multiplier = exp(-ln2 * (t / halfLife)^β)`.
 *   β = 1 degenerates to the exponential curve. β > 1 retains more before
 *   half-life and decays faster after it, which matches human
 *   forgetting curves (Averell & Heathcote 2011) more closely and is the
 *   shape requested by the community in openclaw/openclaw#57307 and #65679.
 *
 * Both models preserve half-life semantics: at `t = halfLifeDays` the
 * multiplier is exactly 0.5 regardless of β, so tuning the shape does not
 * invalidate user-facing halfLife configuration.
 */
export type TemporalDecayModel = "exponential" | "weibull";

export type TemporalDecayConfig = {
  enabled: boolean;
  halfLifeDays: number;
  /**
   * Decay model. Defaults to "exponential" to preserve legacy behavior.
   */
  model: TemporalDecayModel;
  /**
   * Weibull shape parameter β. Only consulted when `model === "weibull"`.
   * - β = 1  → identical to exponential
   * - β > 1  → slower early decay (retains more before half-life), faster long tail (recommended: 1.5)
   * - β < 1  → faster early decay, slower long tail
   * Non-finite or non-positive values fall back to the default. The effective
   * value is clamped to [WEIBULL_SHAPE_MIN, WEIBULL_SHAPE_MAX] to avoid
   * numerical pathologies (e.g. underflow / overflow in Math.pow).
   */
  weibullShape: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
  model: "exponential",
  weibullShape: 1.5,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;

const WEIBULL_SHAPE_MIN = 0.1;
const WEIBULL_SHAPE_MAX = 5;

export function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  return Math.LN2 / halfLifeDays;
}

/**
 * Clamp the Weibull shape parameter to a safe range. Invalid inputs
 * (non-finite, ≤ 0) fall back to the default shape from
 * DEFAULT_TEMPORAL_DECAY_CONFIG so misconfigured callers still get the
 * documented curve rather than NaN / 1 / ∞.
 */
function normalizeWeibullShape(shape: number | undefined): number {
  if (shape === undefined || !Number.isFinite(shape) || shape <= 0) {
    return DEFAULT_TEMPORAL_DECAY_CONFIG.weibullShape;
  }
  return Math.min(WEIBULL_SHAPE_MAX, Math.max(WEIBULL_SHAPE_MIN, shape));
}

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
  model?: TemporalDecayModel;
  weibullShape?: number;
}): number {
  const clampedAge = Math.max(0, params.ageInDays);
  if (
    !Number.isFinite(params.halfLifeDays) ||
    params.halfLifeDays <= 0 ||
    !Number.isFinite(clampedAge)
  ) {
    return 1;
  }

  const model: TemporalDecayModel = params.model ?? "exponential";

  if (model === "weibull") {
    const shape = normalizeWeibullShape(params.weibullShape);
    // multiplier = exp(-ln2 * (t / halfLife)^β)
    // At t = halfLife: (1)^β = 1 ⇒ multiplier = exp(-ln2) = 0.5 for any β,
    // so half-life semantics are preserved across shapes.
    const ratio = clampedAge / params.halfLifeDays;
    return Math.exp(-Math.LN2 * ratio ** shape);
  }

  // Exponential (default, legacy behavior).
  const lambda = toDecayLambda(params.halfLifeDays);
  if (lambda <= 0) {
    return 1;
  }
  return Math.exp(-lambda * clampedAge);
}

export function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
  model?: TemporalDecayModel;
  weibullShape?: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

function parseMemoryDateFromPath(filePath: string): Date | null {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const match = DATED_MEMORY_PATH_RE.exec(normalized);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function isEvergreenMemoryPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "MEMORY.md") {
    return true;
  }
  if (!normalized.startsWith("memory/")) {
    return false;
  }
  return !DATED_MEMORY_PATH_RE.test(normalized);
}

async function extractTimestamp(params: {
  filePath: string;
  source?: string;
  workspaceDir?: string;
}): Promise<Date | null> {
  const fromPath = parseMemoryDateFromPath(params.filePath);
  if (fromPath) {
    return fromPath;
  }

  // Memory root/topic files are evergreen knowledge and should not decay.
  if (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) {
    return null;
  }

  if (!params.workspaceDir) {
    return null;
  }

  const absolutePath = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(params.workspaceDir, params.filePath);

  try {
    const stat = await fs.stat(absolutePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    return new Date(stat.mtimeMs);
  } catch {
    return null;
  }
}

function ageInDaysFromTimestamp(timestamp: Date, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - timestamp.getTime());
  return ageMs / DAY_MS;
}

export async function applyTemporalDecayToHybridResults<
  T extends { path: string; score: number; source: string },
>(params: {
  results: T[];
  temporalDecay?: Partial<TemporalDecayConfig>;
  workspaceDir?: string;
  nowMs?: number;
}): Promise<T[]> {
  const config = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  if (!config.enabled) {
    return [...params.results];
  }

  const nowMs = params.nowMs ?? Date.now();
  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    params.results.map(async (entry) => {
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir: params.workspaceDir,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return entry;
      }

      const decayedScore = applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: ageInDaysFromTimestamp(timestamp, nowMs),
        halfLifeDays: config.halfLifeDays,
        model: config.model,
        weibullShape: config.weibullShape,
      });

      return {
        ...entry,
        score: decayedScore,
      };
    }),
  );
}
