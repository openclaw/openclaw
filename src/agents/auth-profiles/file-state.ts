import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerAgentDatabaseReaderCloser,
} from "../../infra/agent-database-readers.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { observeOwnedDirectory } from "../../infra/owned-directory-observation.js";
import {
  captureSqliteReadOnlyWorkerScope,
  readOnlyWorkerScope,
} from "../../infra/sqlite-readonly-worker-context.js";
import {
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentity,
  databaseFileIdentityKey,
  readDatabaseIdentityBirthtime,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { getSpawnBroker, runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-maintenance-context.js";

type FileChange = {
  directory: string;
  identityChanged: boolean;
  sourcesChanged: boolean;
  createdPaths: readonly string[];
};
type DirectoryState = {
  identities: Map<string, DatabasePathIdentity | undefined>;
  presence: Map<string, boolean>;
  observation: { close(): void };
  publishChange: (change: FileChange) => Promise<void>;
  refresh?: Promise<void>;
  dirty: boolean;
};

const directories = new Map<string, DirectoryState>();
type FileChangeListener = (change: FileChange) => void | Promise<void>;
const listeners = new Set<FileChangeListener>();
const legacyNames = new Set(["auth-profiles.json", "auth-state.json", "auth.json", "oauth.json"]);

function missingFile(error: unknown): null | undefined {
  return hasErrnoCode(error, "ENOENT") ? null : undefined;
}

function retireDirectory(directory: string, state: DirectoryState): void {
  state.observation.close();
  directories.delete(directory);
}

registerOpenClawStateDatabaseAsyncResource({ close: async () => closeAuthProfileFileState() });
registerAgentDatabaseReaderCloser((candidates, retainedPaths) => {
  for (const [directory, state] of directories) {
    for (const databasePath of state.identities.keys()) {
      if (
        !retainedPaths?.has(path.resolve(databasePath)) &&
        candidates.some((candidate) =>
          matchesAgentDatabaseReadCandidatePath(candidate, databasePath),
        )
      ) {
        state.identities.delete(databasePath);
      }
    }
    if (
      !state.identities.size &&
      candidates.some(
        ({ path: pathname }) =>
          path.dirname(path.resolve(pathname)) === directory &&
          !retainedPaths?.has(path.resolve(pathname)),
      )
    ) {
      retireDirectory(directory, state);
    }
  }
});

function refreshDirectory(directory: string, state: DirectoryState): Promise<void> {
  state.dirty = true;
  state.refresh ??= Promise.resolve().then(async () => {
    try {
      while (state.dirty && directories.get(directory) === state) {
        state.dirty = false;
        let identityChanged = false;
        const createdPaths: string[] = [];
        let sourcesChanged = false;
        for (const [databasePath, previous] of state.identities) {
          const file = await stat(databasePath, { bigint: true }).catch(missingFile);
          const current =
            file === undefined
              ? undefined
              : file?.isFile() &&
                  previous?.key === `file:${databaseFileIdentityKey(file)}` &&
                  previous.birthtime === readDatabaseIdentityBirthtime(file)
                ? previous
                : await readDatabasePathIdentity(databasePath).catch(() => undefined);
          if (directories.get(directory) !== state) {
            return;
          }
          if (state.identities.get(databasePath) !== previous) {
            state.dirty = true;
            continue;
          }
          if (current?.key !== previous?.key || current?.birthtime !== previous?.birthtime) {
            if (previous?.key.startsWith("path:") && current?.key.startsWith("file:")) {
              createdPaths.push(databasePath);
            } else {
              identityChanged = true;
            }
            state.identities.set(databasePath, current);
          }
        }
        for (const [sourcePath, previous] of state.presence) {
          const current = await stat(sourcePath).then(
            () => true,
            () => false,
          );
          if (directories.get(directory) !== state) {
            return;
          }
          if (current !== previous) {
            sourcesChanged = true;
            state.presence.set(sourcePath, current);
          }
        }
        if (state.identities.size || sourcesChanged) {
          await state.publishChange({
            directory,
            identityChanged,
            sourcesChanged,
            createdPaths,
          });
        }
      }
    } finally {
      state.refresh = undefined;
    }
  });
  return state.refresh;
}

function captureFileChangePublisher(): DirectoryState["publishChange"] {
  const broker = getSpawnBroker();
  const runWithReaders = captureSqliteReadOnlyWorkerScope();
  const signal = readOnlyWorkerScope.getStore()?.controller.signal;
  // Restore only host readers at publication, after physical file facts settle.
  // A scan spanning a restart uses the current publisher, never old request authority.
  return async (change) => {
    if (signal?.aborted) {
      return;
    }
    await runWithSpawnBroker(broker, () =>
      runWithReaders(() =>
        Promise.all(Array.from(listeners, (listener) => Promise.resolve(listener(change)))),
      ),
    );
  };
}

/** Retained shared state survives a restart; its observers must use the new Gateway readers. */
export function bindAuthProfileFileObservationReaders(): void {
  for (const state of directories.values()) {
    state.publishChange = captureFileChangePublisher();
  }
}

function directoryState(directory: string): DirectoryState {
  const existing = directories.get(directory);
  if (existing) {
    return existing;
  }
  const identities: DirectoryState["identities"] = new Map();
  const state: DirectoryState = {
    identities,
    presence: new Map(),
    dirty: false,
    publishChange: captureFileChangePublisher(),
    observation: observeOwnedDirectory(directory, (filename) => {
      if (
        filename === undefined ||
        legacyNames.has(filename) ||
        [...identities.keys()].some((databasePath) => filename === path.basename(databasePath))
      ) {
        void refreshDirectory(directory, state);
      }
    }),
  };
  directories.set(directory, state);
  return state;
}

/** File facts belong to the auth owner; observation re-admits changed paths off-thread. */
export function readAuthProfileDatabaseIdentity(
  databasePath: string,
): DatabasePathIdentity | undefined {
  const state = directoryState(path.dirname(databasePath));
  if (!state.identities.has(databasePath)) {
    const identity = inspectDatabasePathIdentitySync(databasePath);
    state.identities.set(databasePath, identity);
  }
  return state.identities.get(databasePath);
}

export function captureAuthProfileFileIdentity(databasePath: string) {
  const identity = readAuthProfileDatabaseIdentity(databasePath);
  const state = directoryState(path.dirname(databasePath));
  return {
    identity,
    assertCurrent() {
      if (
        !state.identities.has(databasePath) ||
        state.identities.get(databasePath) !== identity ||
        directories.get(path.dirname(databasePath)) !== state
      ) {
        throw new Error("Auth profile database file identity changed");
      }
    },
  };
}

/** A first owner write makes an admitted absence available to subsequent readers immediately. */
export function noteAuthProfileFileWrite(databasePath: string): void {
  const absent = [...directories.values()].flatMap((state) =>
    [...state.identities].flatMap(([pathname, identity]) =>
      identity?.key.startsWith("file:") ? [] : [{ state, pathname, identity }],
    ),
  );
  if (!absent.length) {
    return;
  }
  const written = inspectDatabasePathIdentitySync(databasePath);
  for (const { state, pathname, identity } of absent) {
    if (
      pathname === databasePath ||
      (written && identity?.canonicalPath === written.canonicalPath)
    ) {
      state.identities.set(pathname, written);
    }
  }
}

export function authProfileSourceExists(sourcePath: string): boolean {
  if (!isMainThread || isArtifactPreservingStateRead() || getOpenClawDatabaseMaintenanceScope()) {
    return fs.existsSync(sourcePath);
  }
  const state = directoryState(path.dirname(sourcePath));
  if (!state.presence.has(sourcePath)) {
    state.presence.set(sourcePath, fs.existsSync(sourcePath));
  }
  return state.presence.get(sourcePath)!;
}

/** Cold credential admission revalidates migration inputs before publishing a new owner. */
export function admitAuthProfileLegacySources(sourcePaths: Iterable<string>): void {
  for (const sourcePath of new Set(sourcePaths)) {
    directoryState(path.dirname(sourcePath)).presence.set(sourcePath, fs.existsSync(sourcePath));
  }
}

export function registerAuthProfileFileChangeListener(listener: FileChangeListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Explicit refresh joins observation without retiring unchanged file authority. */
export async function refreshAuthProfileFileState(): Promise<void> {
  await Promise.all(
    [...directories].map(([directory, state]) => refreshDirectory(directory, state)),
  );
}

function closeAuthProfileFileState(): void {
  for (const [directory, state] of directories) {
    retireDirectory(directory, state);
  }
}
