import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentDatabaseReadCandidatePath,
  type AgentDatabaseReadCandidate,
} from "../../infra/agent-database-readers.js";
import { readSqliteDatabaseScopedWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  buildPersistedAuthProfileSecretsStore,
  mergePersistedAuthProfileState,
} from "./persisted.js";
import { buildPersistedAuthProfileState } from "./state.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

type RowsReader = {
  identity?: string;
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
};

function persistedSource(store: AuthProfileStore | null): AuthProfileStore {
  const current = store ?? { version: AUTH_STORE_VERSION, profiles: {} };
  return {
    ...buildPersistedAuthProfileSecretsStore(current),
    ...buildPersistedAuthProfileState(current),
  };
}

function sourceFromRows(rows: AuthProfileRowRead, databasePath: string): AuthProfileStore {
  const store = mergePersistedAuthProfileState(
    rows.store.status === "readable" ? rows.store.raw : null,
    () => (rows.state.status === "readable" ? rows.state.raw : null),
  );
  if (!store && rows.store.status !== "missing") {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  return persistedSource(store);
}

/** Persisted rows follow their source owner, independently of resolved snapshot publication. */
export function createRuntimeAuthProfileRowsCache(
  revisionAtPath: (path: string) => string,
  waitForSourcePublication: (databasePath: string) => Promise<void>,
) {
  type Refresh = () => Promise<AuthProfileRowRead | undefined>;
  type Entry = {
    identity: string | undefined;
    writeToken: string | undefined;
    revision: string;
    source: AuthProfileStore;
    rows?: AuthProfileRowRead;
    refresh?: Refresh;
  };
  const entries = new Map<string, Entry>();
  const hasCurrentSource = (databasePath: string, entry: Entry) =>
    revisionAtPath(databasePath) === entry.revision &&
    readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") === entry.writeToken;
  const isCurrent = (databasePath: string, entry: Entry) =>
    entries.get(databasePath) === entry && hasCurrentSource(databasePath, entry);
  return {
    hasSource(databasePath: string): boolean {
      const entry = entries.get(databasePath);
      return Boolean(
        entry?.refresh &&
        revisionAtPath(databasePath) === entry.revision &&
        (entry.writeToken === undefined || hasCurrentSource(databasePath, entry)),
      );
    },
    recordSource(
      databasePath: string,
      identity: string,
      store: AuthProfileStore | null,
      refresh: Refresh,
    ) {
      const writeToken = readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles");
      const source = freezeJsonSnapshot(structuredClone(persistedSource(store)));
      const previous = entries.get(databasePath);
      entries.set(databasePath, {
        identity,
        writeToken,
        revision: revisionAtPath(databasePath),
        source,
        refresh,
        ...(previous?.identity === identity &&
        previous.writeToken === writeToken &&
        isDeepStrictEqual(previous.source, source)
          ? { rows: previous.rows }
          : {}),
      });
    },
    invalidateRows(databasePath?: string) {
      for (const [pathname, entry] of entries) {
        if (databasePath === undefined || pathname === databasePath) {
          entry.rows = undefined;
        }
      }
    },
    clear(databasePath?: string) {
      if (databasePath === undefined) {
        entries.clear();
      } else {
        entries.delete(databasePath);
      }
    },
    retire(candidates: readonly AgentDatabaseReadCandidate[], retainedPaths?: ReadonlySet<string>) {
      for (const databasePath of entries.keys()) {
        if (
          !retainedPaths?.has(databasePath) &&
          candidates.some((candidate) =>
            matchesAgentDatabaseReadCandidatePath(candidate, databasePath),
          )
        ) {
          entries.delete(databasePath);
        }
      }
    },
    publishSnapshots(databasePaths: ReadonlySet<string>) {
      for (const databasePath of entries.keys()) {
        if (!databasePaths.has(databasePath)) {
          entries.delete(databasePath);
        }
      }
    },
    rebase(databasePath: string) {
      const entry = entries.get(databasePath);
      if (
        entry &&
        (entry.writeToken === undefined ||
          readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") ===
            entry.writeToken)
      ) {
        entry.revision = revisionAtPath(databasePath);
      }
    },
    async refreshChanged(directory: string): Promise<string[]> {
      const key = path.resolve(directory);
      const changed = new Map<string, Entry>();
      // Async reads must not visit owners installed during this observation.
      const observedEntries = Array.from(entries);
      for (const [databasePath, entry] of observedEntries) {
        if (path.dirname(path.resolve(databasePath)) !== key || !entry.refresh) {
          continue;
        }
        for (;;) {
          // Native source publication can precede the first scoped SQLite admission.
          entry.writeToken ??= readSqliteDatabaseScopedWriteTokenForPath(
            databasePath,
            "auth-profiles",
          );
          if (!isCurrent(databasePath, entry)) {
            break;
          }
          const writeToken = entry.writeToken;
          let rows: AuthProfileRowRead | undefined;
          let source: AuthProfileStore | undefined;
          try {
            rows = await entry.refresh();
            if (!rows) {
              break;
            }
            source = sourceFromRows(rows, databasePath);
          } catch {
            // A failed external reread cannot certify the cached credential facts.
          }
          // Disk commits can precede their source publication while the read awaits.
          await waitForSourcePublication(databasePath);
          if (
            entries.get(databasePath) === entry &&
            revisionAtPath(databasePath) === entry.revision &&
            writeToken === undefined
          ) {
            entry.writeToken = readSqliteDatabaseScopedWriteTokenForPath(
              databasePath,
              "auth-profiles",
            );
            if (entry.writeToken !== undefined) {
              continue;
            }
          }
          if (!isCurrent(databasePath, entry)) {
            break;
          }
          if (
            !rows ||
            source === undefined ||
            rows.store.status === "unreadable" ||
            rows.state.status === "unreadable" ||
            !isDeepStrictEqual(source, entry.source)
          ) {
            entries.delete(databasePath);
            changed.set(databasePath, entry);
          } else if (rows.cacheable && entry.writeToken !== undefined) {
            freezeJsonSnapshot(rows);
            entry.rows ??= rows;
          } else {
            entry.rows = undefined;
          }
          break;
        }
      }
      return [...changed].flatMap(([databasePath, entry]) =>
        !entries.has(databasePath) && hasCurrentSource(databasePath, entry) ? [databasePath] : [],
      );
    },
    prepare(databasePath: string, reader: RowsReader, refresh?: Refresh, reuse = true): RowsReader {
      const revision = revisionAtPath(databasePath);
      return {
        assertCurrent: reader.assertCurrent,
        async read() {
          reader.assertCurrent();
          const entry = entries.get(databasePath);
          // Session-only writes leave auth rows intact; auth and unscoped writes still fence reuse.
          const writeToken = readSqliteDatabaseScopedWriteTokenForPath(
            databasePath,
            "auth-profiles",
          );
          if (
            reuse &&
            writeToken !== undefined &&
            entry?.identity === reader.identity &&
            entry?.revision === revision &&
            entry.writeToken === writeToken &&
            entry.rows
          ) {
            entry.refresh = refresh ?? entry.refresh;
            return entry.rows;
          }
          if (entry) {
            entry.rows = undefined;
          }
          // Source provenance can precede admission; reusable rows require a stable receipt.
          const rows = await reader.read();
          reader.assertCurrent();
          if (
            rows.store.status !== "unreadable" &&
            rows.state.status !== "unreadable" &&
            revisionAtPath(databasePath) === revision &&
            (writeToken === undefined ||
              readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") ===
                writeToken)
          ) {
            freezeJsonSnapshot(rows);
            entries.set(databasePath, {
              identity: reader.identity,
              writeToken,
              revision,
              ...(rows.cacheable && writeToken !== undefined ? { rows } : {}),
              source: sourceFromRows(rows, databasePath),
              refresh,
            });
          }
          return rows;
        },
      };
    },
  };
}
