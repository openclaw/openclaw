import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type LocationTouchOutcome,
  type TouchableHit,
  recordTouchedLocations,
} from "../location/location-touch.js";
import { type MemorySource, memoryLocationId } from "../ref.js";
import { openSidecarDatabase } from "../sidecar-store.js";
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

  const openDb = deps.openDb ?? createDefaultOpener();
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
        const hits: TouchableHit[] = results.map((r) => ({
          source: r.source,
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
        }));
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

function createDefaultOpener(): (workspaceDir: string) => DatabaseSync {
  const cache = new Map<string, DatabaseSync>();
  return (workspaceDir) => {
    const cached = cache.get(workspaceDir);
    if (cached) {
      return cached;
    }
    const dbPath = path.join(workspaceDir, "memory", "v2-sidecar.db");
    const db = openSidecarDatabase(dbPath);
    cache.set(workspaceDir, db);
    return db;
  };
}
