import {
  matchesAgentDatabaseReadCandidatePath,
  type AgentDatabaseReadCandidate,
} from "../../infra/agent-database-readers.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath } from "./mutation-lineage.js";
import { readAuthProfileRowsReceipt } from "./persisted-rows-receipt.js";
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
    receipt: object;
    revision: string;
    rows?: AuthProfileRowRead;
    canonical: boolean;
  };
  const entries = new Map<string, Entry>();
  const hasCurrentSource = (databasePath: string, entry: Entry) =>
    revisionAtPath(databasePath) === entry.revision &&
    readAuthProfileRowsReceipt(databasePath) === entry.receipt;
  return {
    hasSource(databasePath: string): boolean {
      const entry = entries.get(databasePath);
      return Boolean(entry && hasCurrentSource(databasePath, entry));
    },
    recordSource(databasePath: string, identity: string, store: AuthProfileStore | null) {
      const entry = entries.get(databasePath);
      // Runtime postimages omit private authorization lifetimes. Keep the complete rows
      // when this publication describes the same admitted source without an auth write.
      if (
        store &&
        entry?.canonical &&
        entry.rows &&
        entry.identity === identity &&
        hasCurrentSource(databasePath, entry)
      ) {
        return;
      }
      const source = store && structuredClone(store);
      entries.set(databasePath, {
        identity,
        receipt: readAuthProfileRowsReceipt(databasePath),
        revision: revisionAtPath(databasePath),
        canonical: false,
        // Persisted values precede runtime secret overlays but omit private lifetimes.
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
      if (entry && readAuthProfileRowsReceipt(databasePath) === entry.receipt) {
        entry.revision = revisionAtPath(databasePath);
      }
    },
    prepare(
      databasePath: string,
      reader: RowsReader,
      source: "runtime" | "canonical" = "runtime",
    ): RowsReader {
      return {
        assertCurrent: reader.assertCurrent,
        async read() {
          reader.assertCurrent();
          const revision = revisionAtPath(databasePath);
          const entry = entries.get(databasePath);
          const receipt = readAuthProfileRowsReceipt(databasePath);
          if (
            entry?.identity === reader.identity &&
            entry?.revision === revision &&
            entry.receipt === receipt &&
            entry.rows &&
            (source !== "canonical" || entry.canonical)
          ) {
            return entry.rows;
          }
          if (entry) {
            entry.rows = undefined;
          }
          const rows = await reader.read();
          if (rows.store.status !== "unreadable" && rows.state.status !== "unreadable") {
            freezeJsonSnapshot(rows);
            // A write overtaking discovery invalidates this receipt at the next lookup.
            // Actual credential use still checks the credential owner's live authority.
            entries.set(databasePath, {
              identity: reader.identity,
              receipt,
              revision,
              rows,
              canonical: true,
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
