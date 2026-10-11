import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { AuthProfileRowRead } from "./types.js";

type RowsReader = {
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
};

export class AuthProfileRuntimeReadStaleError extends Error {
  constructor(readonly waitForSettlement?: (signal?: AbortSignal) => Promise<void>) {
    super("Auth profile store changed during its runtime read; retry resolution");
    this.name = "AuthProfileRuntimeReadStaleError";
  }
}

/** A derived rows cache; the runtime snapshot owner supplies publication generations. */
export function createRuntimeAuthProfileRowsCache(
  revisionAtPath: (path: string) => {
    rows: string;
    selection: string;
    ownerLineage?: readonly string[];
  },
) {
  const entries = new Map<
    string,
    { writeToken: string; revision: string; rows: AuthProfileRowRead }
  >();
  return {
    clear(databasePath?: string) {
      if (databasePath === undefined) {
        entries.clear();
      } else {
        entries.delete(databasePath);
      }
    },
    prepare(
      databasePath: string,
      reader: RowsReader,
      captureSettlement?: (
        databasePaths: readonly string[],
        rows: AuthProfileRowRead | undefined,
      ) => ((signal?: AbortSignal) => Promise<void>) | undefined,
    ): RowsReader {
      const revision = revisionAtPath(databasePath);
      const ownerLineage = [databasePath, ...(revision.ownerLineage ?? [])];
      let capturedRows: AuthProfileRowRead | undefined;
      const assertCurrent = () => {
        reader.assertCurrent();
        // Bookkeeping evicts reusable rows without revoking an admitted snapshot read.
        if (revisionAtPath(databasePath).selection !== revision.selection) {
          throw new AuthProfileRuntimeReadStaleError(
            captureSettlement?.(ownerLineage, capturedRows),
          );
        }
      };
      return {
        assertCurrent,
        async read() {
          assertCurrent();
          const entry = entries.get(databasePath);
          const writeToken = readSqliteDatabaseWriteTokenForPath(databasePath);
          if (
            writeToken !== undefined &&
            entry?.revision === revision.rows &&
            entry.writeToken === writeToken
          ) {
            capturedRows = entry.rows;
            return entry.rows;
          }
          entries.delete(databasePath);
          // Only completed, certified reads can serve another caller's later snapshot.
          const rows = await reader.read();
          capturedRows = rows;
          assertCurrent();
          if (
            rows.cacheable &&
            rows.store.status !== "unreadable" &&
            rows.state.status !== "unreadable" &&
            revisionAtPath(databasePath).rows === revision.rows &&
            writeToken !== undefined &&
            readSqliteDatabaseWriteTokenForPath(databasePath) === writeToken
          ) {
            freezeJsonSnapshot(rows);
            entries.set(databasePath, { writeToken, revision: revision.rows, rows });
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
