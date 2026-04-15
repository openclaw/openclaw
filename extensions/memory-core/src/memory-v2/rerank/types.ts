import type { MemorySource } from "../ref.js";
import type { SidecarStatus } from "../sidecar-repo.js";

// Minimum fields the rerank pipeline needs from a search result. Defined as a
// structural type so it accepts MemorySearchResult (from the host SDK) and
// any in-package shape used by tests, without an external import.
export type RerankableResult = {
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
};

// Just the sidecar columns the formula reads. Keep this narrow so adding more
// columns in later slices doesn't force this surface to grow.
export type RerankSignals = {
  salience: number | null;
  pinned: boolean;
  status: SidecarStatus;
  lastAccessedAt: number | null;
};

export type RerankConfig = {
  // Multiplier on the salience term: 1 + salienceWeight * salience01.
  // Default: 0.5
  salienceWeight?: number;
  // Half-life in days for the recency decay multiplier. 0 disables decay.
  // Default: 14
  recencyHalfLifeDays?: number;
  // Multiplicative boost for pinned rows: ×(1 + pinnedBoost). Default: 1.0
  pinnedBoost?: number;
  // Multiplicative penalty for superseded rows: ×(1 - supersededPenalty).
  // Default: 0.5
  supersededPenalty?: number;
  // Floor for recency decay so very old rows do not vanish. Default: 0.25
  recencyFloor?: number;
  // Default salience used when a row exists but has no salience set yet
  // (Slice 1.5 shadow rows). Default: 0.5
  defaultSalience?: number;
};

export const RERANK_DEFAULTS = {
  salienceWeight: 0.5,
  recencyHalfLifeDays: 14,
  pinnedBoost: 1.0,
  supersededPenalty: 0.5,
  recencyFloor: 0.25,
  defaultSalience: 0.5,
} as const;

export type RerankContext = {
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
};

export type RerankFn = <T extends RerankableResult>(
  results: readonly T[],
  ctx: RerankContext,
) => T[] | Promise<T[]>;
