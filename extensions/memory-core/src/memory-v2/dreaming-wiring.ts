import type { DatabaseSync } from "node:sqlite";
import type { ShortTermRecallEntry } from "../short-term-promotion.js";
import { type TouchableHit, recordTouchedLocations } from "./location/location-touch.js";
import { createSidecarOpener } from "./sidecar-store.js";

// Module-level lazy singleton so successive dreaming sweeps share one
// workspace-keyed opener (and its DatabaseSync cache) instead of each sweep
// creating a fresh cache and opening a new handle per workspace. Ingest and
// rerank achieve the same dedup by closing the opener over their respective
// handler factories (`buildAgentEndHandler`, `buildRerankWrapper`); D1/D2
// have no plugin-register factory to capture it in, so the dedup lives at
// module scope instead.
let defaultOpener: ReturnType<typeof createSidecarOpener> | undefined;
function getDefaultOpener(): ReturnType<typeof createSidecarOpener> {
  if (!defaultOpener) {
    defaultOpener = createSidecarOpener();
  }
  return defaultOpener;
}

// Step-zero path-representation outcome (Slice D1, 2026-04-16): short-term
// entries with `source: "memory"` already carry paths normalized via
// `normalizeMemoryPath` to a `memory/<file>` shape; no dreaming-side
// normalizer is needed. Ingest-produced rows live in a disjoint
// `:conversation/<sessionId>` path space and are never refreshed by this
// wiring — D1 always hits the shadow-stub insert branch on cited daily-memory
// locations, same pattern rerank uses on recalled memory results.

// Public-config gate. Reads `memoryV2.dreamingShadowTouch.enabled` from the
// plugin config without any schema dep; default is false. Type-guarded so a
// malformed config never enables the hook by accident.
export function readDreamingShadowTouchEnabled(pluginConfig: unknown): boolean {
  if (!isRecord(pluginConfig)) {
    return false;
  }
  const memoryV2 = pluginConfig.memoryV2;
  if (!isRecord(memoryV2)) {
    return false;
  }
  const section = memoryV2.dreamingShadowTouch;
  if (!isRecord(section)) {
    return false;
  }
  return section.enabled === true;
}

export type DreamingWiringDeps = {
  // Resolves and opens (lazily) the per-workspace sidecar db. Cached by
  // workspace path so successive dreaming sweeps share a connection.
  openDb?: (workspaceDir: string) => DatabaseSync;
  // Injected for tests. Defaults to recordTouchedLocations.
  touch?: typeof recordTouchedLocations;
  // Logger surface; defaults to a noop. Wiring must never throw out to the
  // dreaming phase.
  logWarn?: (message: string, err?: unknown) => void;
  // Clock injection point; defaults to Date.now.
  now?: () => number;
};

// Adapts cited short-term entries into TouchableHit[] and delegates to the
// existing shadow-touch primitive shared with the Slice 2b/3a rerank path.
// Phase-neutral: callers in both light and REM dreaming pass their own
// already-narrowed "cited" set. A cited entry whose `source` is not "memory"
// is skipped; a dreaming sweep with no qualifying entries opens no db and
// writes nothing.
export function touchSidecarFromDreamingEntries(
  deps: DreamingWiringDeps,
  entries: readonly ShortTermRecallEntry[],
  workspaceDir: string,
): void {
  if (entries.length === 0) {
    return;
  }
  const logWarn = deps.logWarn ?? (() => {});
  try {
    const hits: TouchableHit[] = [];
    for (const entry of entries) {
      if (entry.source !== "memory") {
        continue;
      }
      hits.push({
        source: entry.source,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
      });
    }
    if (hits.length === 0) {
      return;
    }
    const openDb = deps.openDb ?? getDefaultOpener();
    const touch = deps.touch ?? recordTouchedLocations;
    const now = deps.now ?? Date.now;
    const db = openDb(workspaceDir);
    touch(db, hits, now());
  } catch (err) {
    logWarn("memory-v2 dreaming shadow-touch failed", err);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
