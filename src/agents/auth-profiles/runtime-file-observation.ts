import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { registerAgentDatabaseReaderCloser } from "../../infra/agent-database-readers.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-maintenance-context.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import {
  readAuthProfileDatabaseIdentity,
  refreshAuthProfileFileState,
  registerAuthProfileFileChangeListener,
} from "./file-state.js";
import type { createRuntimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import type { OwnedRuntimeSnapshot } from "./runtime-snapshot-selection.js";
import type { AuthProfileStore } from "./types.js";

/** Observe persisted sources while snapshot publication stays with its existing owner. */
export function createRuntimeAuthProfileFileObservation({
  snapshots,
  rowsCache,
  invalidatePaths,
}: {
  snapshots: ReadonlyMap<string, OwnedRuntimeSnapshot>;
  rowsCache: ReturnType<typeof createRuntimeAuthProfileRowsCache>;
  invalidatePaths: (
    paths: readonly string[],
    isCurrent?: (databasePath: string) => boolean,
  ) => void;
}) {
  let refreshExternalAuth: ((paths: readonly string[]) => Promise<boolean>) | undefined;
  let externalRefresh: Promise<void> | undefined;
  let externalRefreshRevision = 0;
  const externalChanges = new Map<string, ReadonlyMap<string, OwnedRuntimeSnapshot>>();

  /** Only canonical reads and committed local stores establish file-backed source provenance. */
  function recordRuntimeAuthProfilePersistedStore(
    databasePath: string,
    store: AuthProfileStore | null,
  ): void {
    if (isArtifactPreservingStateRead() || getOpenClawDatabaseMaintenanceScope()) {
      return;
    }
    const identity = readAuthProfileDatabaseIdentity(databasePath);
    // Workers retain physical-file observation, but native tasks reload their own rows.
    if (!identity || !isMainThread) {
      return;
    }
    rowsCache.recordSource(databasePath, `${identity.key}:${identity.birthtime ?? ""}`, store);
  }

  /** Explicit refresh retires cached rows; the next owner read reloads persisted facts. */
  async function refreshRuntimeAuthProfileStoreSources(): Promise<void> {
    await refreshAuthProfileFileState();
    rowsCache.invalidateRows();
  }

  registerAgentDatabaseReaderCloser((candidates, retainedPaths) => {
    rowsCache.retire(candidates, retainedPaths);
  });

  /** Secrets activation remains the owner of resolved credential publications. */
  function registerRuntimeAuthProfileExternalRefresh(
    refresh: (paths: readonly string[]) => Promise<boolean>,
  ): void {
    refreshExternalAuth = refresh;
  }

  function refreshExternalAuthPaths(paths: readonly string[]): void {
    if (paths.length) {
      const expected = new Map(snapshots);
      for (const pathname of paths) {
        externalChanges.set(pathname, expected);
      }
    }
    if (externalRefresh || !externalChanges.size) {
      return;
    }
    externalRefresh = (async () => {
      const revision = externalRefreshRevision;
      while (externalChanges.size) {
        if (revision !== externalRefreshRevision) {
          break;
        }
        const pending = [...externalChanges];
        externalChanges.clear();
        const invalidateCurrent = () => {
          for (const [pathname, captured] of pending) {
            invalidatePaths([pathname], (target) => snapshots.get(target) === captured.get(target));
          }
        };
        try {
          if (
            !(await refreshExternalAuth?.(pending.map(([pathname]) => pathname))) &&
            revision === externalRefreshRevision
          ) {
            invalidateCurrent();
          }
        } catch (error) {
          if (revision !== externalRefreshRevision) {
            return;
          }
          invalidateCurrent();
          reportCommittedInlineAuthFailure("Auth file observation refresh failed", error);
        }
      }
    })().finally(() => {
      externalRefresh = undefined;
      refreshExternalAuthPaths([]);
    });
  }

  registerAuthProfileFileChangeListener(
    ({ directory, identityChanged, sourcesChanged, createdPaths }) => {
      const unprovenCreation = createdPaths.some((pathname) => !rowsCache.hasSource(pathname));
      // In-process writes publish rows; file observation only retires replaced sources.
      if (!identityChanged && !sourcesChanged && !unprovenCreation) {
        return;
      }
      const paths = [...snapshots].flatMap(([key, entry]) => {
        const candidates = entry.legacyCandidates;
        return path.dirname(key) === directory ||
          (entry.owner.kind === "resolved" &&
            path.dirname(entry.owner.sharedDatabasePath) === directory) ||
          (sourcesChanged &&
            candidates &&
            [...candidates.local, ...candidates.shared].some(
              (source) => path.dirname(source.path) === directory,
            ))
          ? [key]
          : [];
      });
      invalidatePaths(paths);
      refreshExternalAuthPaths(paths);
    },
  );

  return {
    recordRuntimeAuthProfilePersistedStore,
    refreshRuntimeAuthProfileStoreSources,
    registerRuntimeAuthProfileExternalRefresh,
    reset() {
      externalRefreshRevision += 1;
      externalChanges.clear();
    },
  };
}
