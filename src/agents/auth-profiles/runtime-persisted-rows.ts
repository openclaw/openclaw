import {
  matchesAgentDatabaseReadCandidatePath,
  type AgentDatabaseReadCandidate,
} from "../../infra/agent-database-readers.js";
import { readSqliteDatabaseScopedWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath } from "./mutation-lineage.js";
import { buildPersistedAuthProfileSecretsStore } from "./persisted.js";
import { buildPersistedAuthProfileState } from "./state.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

type RowsReader = {
  identity?: string;
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
};

/** Persisted rows follow their source owner, independently of resolved snapshot publication. */
export function createRuntimeAuthProfileRowsCache(revisionAtPath: (path: string) => string) {
  type Entry = {
    identity: string | undefined;
    writeToken: string | undefined;
    revision: string;
    rows?: AuthProfileRowRead;
  };
  const entries = new Map<string, Entry>();
  const hasCurrentSource = (databasePath: string, entry: Entry) =>
    revisionAtPath(databasePath) === entry.revision &&
    // First session creation admits a previously absent source without changing auth facts.
    (entry.writeToken === undefined ||
      readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") ===
        entry.writeToken);
  return {
    hasSource(databasePath: string): boolean {
      const entry = entries.get(databasePath);
      return Boolean(entry && hasCurrentSource(databasePath, entry));
    },
    recordSource(databasePath: string, identity: string, store: AuthProfileStore | null) {
      const source = store && structuredClone(store);
      entries.set(databasePath, {
        identity,
        writeToken: readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles"),
        revision: revisionAtPath(databasePath),
        // Only canonical persisted values enter this cache, before runtime secret overlays.
        rows: source
          ? freezeJsonSnapshot({
              store: { status: "readable", raw: buildPersistedAuthProfileSecretsStore(source) },
              state: { status: "readable", raw: buildPersistedAuthProfileState(source) },
              cacheable: true,
            } satisfies AuthProfileRowRead)
          : undefined,
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
    prepare(databasePath: string, reader: RowsReader): RowsReader {
      return {
        assertCurrent: reader.assertCurrent,
        async read() {
          reader.assertCurrent();
          const revision = revisionAtPath(databasePath);
          const entry = entries.get(databasePath);
          // Session-only writes leave auth rows intact; auth and unscoped writes still fence reuse.
          const writeToken = readSqliteDatabaseScopedWriteTokenForPath(
            databasePath,
            "auth-profiles",
          );
          if (
            writeToken !== undefined &&
            entry?.identity === reader.identity &&
            entry?.revision === revision &&
            entry.writeToken === writeToken &&
            entry.rows
          ) {
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
              ...(writeToken !== undefined ? { rows } : {}),
            });
          }
          return rows;
        },
      };
    },
  };
}

export const runtimeAuthProfileRowsCache = createRuntimeAuthProfileRowsCache((databasePath) =>
  String(getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(databasePath)),
);
