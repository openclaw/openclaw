import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { AuthProfileRowRead } from "./types.js";

type RowsReader = {
  identity?: string;
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
};

/** A derived rows cache; the runtime snapshot owner supplies publication generations. */
export function createRuntimeAuthProfileRowsCache(revisionAtPath: (path: string) => string) {
  const entries = new Map<
    string,
    { identity: string | undefined; writeToken: string; revision: string; rows: AuthProfileRowRead }
  >();
  return {
    clear(databasePath?: string) {
      if (databasePath === undefined) {
        entries.clear();
      } else {
        entries.delete(databasePath);
      }
    },
    prepare(databasePath: string, reader: RowsReader): RowsReader {
      const revision = revisionAtPath(databasePath);
      return {
        assertCurrent: reader.assertCurrent,
        async read() {
          reader.assertCurrent();
          const entry = entries.get(databasePath);
          const writeToken = readSqliteDatabaseWriteTokenForPath(databasePath);
          if (
            writeToken !== undefined &&
            entry?.identity === reader.identity &&
            entry?.revision === revision &&
            entry.writeToken === writeToken
          ) {
            return entry.rows;
          }
          entries.delete(databasePath);
          // Only completed, certified reads can serve another caller's later snapshot.
          const rows = await reader.read();
          reader.assertCurrent();
          if (
            rows.cacheable &&
            rows.store.status !== "unreadable" &&
            rows.state.status !== "unreadable" &&
            revisionAtPath(databasePath) === revision &&
            writeToken !== undefined &&
            readSqliteDatabaseWriteTokenForPath(databasePath) === writeToken
          ) {
            freezeJsonSnapshot(rows);
            entries.set(databasePath, { identity: reader.identity, writeToken, revision, rows });
            // Bound retained credential owners; eviction never changes read authority.
            while (entries.size > 64) {
              entries.delete(entries.keys().next().value!);
            }
          }
          return rows;
        },
      };
    },
  };
}
