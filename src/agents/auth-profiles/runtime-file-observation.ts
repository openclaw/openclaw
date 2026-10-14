import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
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
import { readAuthProfileRowsAtPath } from "./sqlite-read.js";
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
    env: NodeJS.ProcessEnv = process.env,
  ): void {
    if (isArtifactPreservingStateRead() || getOpenClawDatabaseMaintenanceScope()) {
      return;
    }
    const identity = readAuthProfileDatabaseIdentity(databasePath);
    // Workers retain physical-file observation, but native tasks reload their own rows.
    if (!identity || !isMainThread) {
      return;
    }
    const capturedEnv = cloneEnvWithPlatformSemantics(env);
    capturedEnv.OPENCLAW_STATE_DIR = resolveStateDir(capturedEnv);
    rowsCache.recordSource(databasePath, `${identity.key}:${identity.birthtime ?? ""}`, store, () =>
      readAuthProfileRowsAtPath(databasePath, capturedEnv),
    );
  }

  /** User-requested refresh reads persisted sources before observation delivers a change. */
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
    ({ directory, identityChanged, sourcesChanged, contentsChanged, createdPaths }) => {
      const unprovenCreation = createdPaths.some((pathname) => !rowsCache.hasSource(pathname));
      // Coarse observation checks file facts without reopening unchanged auth sources.
      if (!identityChanged && !sourcesChanged && !contentsChanged && !unprovenCreation) {
        return Promise.resolve();
      }
      if (identityChanged || sourcesChanged || unprovenCreation) {
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
      }
      // Session writes share these files; only changed auth rows invalidate published credentials.
      return rowsCache
        .refreshChanged(directory)
        .then(refreshExternalAuthPaths)
        .catch((error: unknown) => {
          reportCommittedInlineAuthFailure("Auth file observation refresh failed", error);
        });
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
