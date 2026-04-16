import type { DatabaseSync } from "node:sqlite";
import {
  type LocationTouchOutcome,
  type TouchableHit,
  recordTouchedLocations,
} from "../location/location-touch.js";
import { type MemorySource, memoryLocationId } from "../ref.js";
import { createSidecarOpener } from "../sidecar-store.js";
import { loadSidecarSignalsByLocations } from "./lookup.js";
import { applyRerank } from "./score.js";
import type { RerankConfig, RerankContext, RerankFn, RerankableResult } from "./types.js";

export type RerankWiringDeps = {
  // Resolves and opens (lazily) the per-workspace sidecar db. Cached by
  // workspace path so all turns of the same agent share a connection.
  openDb?: (workspaceDir: string) => DatabaseSync;
  // Injected for tests. Defaults to loadSidecarSignalsByLocations.
  loadSignals?: typeof loadSidecarSignalsByLocations;
  // Injected for tests. Defaults to recordTouchedLocations.
  touch?: (db: DatabaseSync, hits: readonly TouchableHit[], now: number) => LocationTouchOutcome;
  // Logger surface; defaults to a noop. Wrapper must never throw.
  logWarn?: (message: string, err?: unknown) => void;
  // Clock injection point; defaults to Date.now.
  now?: () => number;
};

export type RerankWrapperOptions = {
  enabled: boolean;
  cfg?: RerankConfig;
  shadowOnRecall?: boolean;
};

// Builds a RerankFn. Returns identity (a no-op that returns its input verbatim)
// when `enabled` is false. When enabled, looks up sidecar signals for each
// result and rescales `score` per the formula in score.ts. Optionally writes
// shadow rows for previously-unseen locations (off by default).
//
// All failure modes degrade to identity rather than throwing — the calling
// tool path must remain resilient.
export function buildRerankWrapper(
  options: RerankWrapperOptions,
  deps: RerankWiringDeps = {},
): RerankFn {
  if (!options.enabled) {
    return identityFn;
  }

  const openDb = deps.openDb ?? createSidecarOpener();
  const loadSignals = deps.loadSignals ?? loadSidecarSignalsByLocations;
  const touch = deps.touch ?? recordTouchedLocations;
  const logWarn = deps.logWarn ?? (() => {});
  const now = deps.now ?? Date.now;
  const shadowOnRecall = options.shadowOnRecall === true;

  return <T extends RerankableResult>(results: readonly T[], ctx: RerankContext): T[] => {
    if (results.length === 0) {
      return [...results];
    }
    if (!ctx.workspaceDir) {
      return [...results];
    }
    try {
      const db = openDb(ctx.workspaceDir);
      const ts = now();
      const locationIds = results.map((r) => locationIdOf(r));
      const signals = loadSignals(db, locationIds);
      const reranked = applyRerank({
        results,
        signalsByLocation: signals,
        locationIdOf,
        cfg: options.cfg,
        now: ts,
      });
      if (shadowOnRecall) {
        // Supplement/wiki results reach this wrapper via an `as never` cast
        // in tools.ts and may lack the NOT NULL fields the sidecar insert
        // requires. Filter to true memory-v2 sources before writing shadows.
        const hits: TouchableHit[] = [];
        for (const r of results) {
          if (r.source === "memory" || r.source === "sessions") {
            hits.push({
              source: r.source,
              path: r.path,
              startLine: r.startLine,
              endLine: r.endLine,
            });
          }
        }
        touch(db, hits, ts);
      }
      return reranked;
    } catch (err) {
      logWarn("memory-v2 rerank failed; returning original results", err);
      return [...results];
    }
  };
}

const identityFn: RerankFn = <T extends RerankableResult>(results: readonly T[]): T[] => [
  ...results,
];

function locationIdOf(result: {
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
}): string {
  return memoryLocationId({
    source: result.source,
    path: result.path,
    startLine: result.startLine,
    endLine: result.endLine,
  });
}
