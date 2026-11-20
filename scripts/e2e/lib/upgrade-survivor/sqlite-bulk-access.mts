import type {
  ObservedSqliteStatement,
  SqliteAuthorization,
  SqliteCatalog,
  SqliteColumnFact,
  SqliteMigrationObservation,
  SqliteMigrationRange,
  SqliteTableFact,
} from "./sqlite-migration-observation.mts";

// Exact row-store names from openclaw-agent-schema.sql and the memory search owner.
// Virtual roots (including newly introduced modules) and their actual shadows are catalog roles.
const bulkTables = new Set([
  "transcript_events",
  "session_transcript_cold_archives",
  "session_transcript_cold_archive_chunks",
  "memory_index_chunks",
  "memory_embedding_cache",
  "memory_index_chunks_vec",
  "session_transcript_fts_rows",
  "session_transcript_fts",
  "standing_intents_fts",
  "memory_index_chunks_fts",
  "memory_index_paths_fts",
]);
const rowActions = new Map([
  [9, "DELETE"],
  [18, "INSERT"],
  [20, "READ"],
  [23, "UPDATE"],
  [27, "REINDEX"],
  [28, "ANALYZE"],
  [1, "CREATE_INDEX"],
]);
const schemaActions = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 26, 29, 30]);

type MigrationBulkAccessReceipt = {
  violations: Array<{
    store: string;
    fromVersion: number;
    toVersion: number;
    table: string;
    reason: string;
    sql: string;
  }>;
  integrityChecks: string[];
  coverageFailures: string[];
};

function tableKey(schema: string, name: string): string {
  return `${schema.toLowerCase()}\0${name.toLowerCase()}`;
}
function actions(statement: ObservedSqliteStatement): SqliteAuthorization[] {
  // Compilation intentions remain relevant on cache hits; execution adds reprepare/virtual work.
  return [...statement.preparedAuthorizations, ...statement.executedAuthorizations];
}
function sameColumn(a: SqliteColumnFact, b: SqliteColumnFact, names = true): boolean {
  return (
    (!names || a.name === b.name) &&
    a.cid === b.cid &&
    a.type === b.type &&
    a.notNull === b.notNull &&
    a.defaultValue === b.defaultValue &&
    a.primaryKey === b.primaryKey &&
    a.hidden === b.hidden
  );
}
function constantDefault(value: string | null): boolean {
  if (value === null) {
    return true;
  }
  return /^(?:NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[+-]?0x[\da-f]+|'(?:[^']|'')*'|x'(?:[\da-f]{2})*')$/iu.test(
    value.trim(),
  );
}
function validationClauses(sql: string | null): number {
  // Inspect catalog DDL, not executable batches. Quoted defaults/identifiers are not clauses.
  const keywords = (sql ?? "").replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/gu,
    " ",
  );
  return keywords.match(/\b(?:CHECK|GENERATED)\b/giu)?.length ?? 0;
}
function constantAlter(
  before: SqliteTableFact,
  after: SqliteTableFact,
  auth: SqliteAuthorization[],
): boolean {
  if (before.type !== "table" || after.type !== "table") {
    return false;
  }
  if (
    auth.some(
      (a) => a.action === 19 && /^(?:quick_check|integrity_check)$/iu.test(a.argument1 ?? ""),
    )
  ) {
    return false;
  }
  if (validationClauses(after.sql) > validationClauses(before.sql)) {
    return false;
  }
  const oldColumns = before.columns;
  const newColumns = after.columns;
  if (
    newColumns.length === oldColumns.length + 1 &&
    oldColumns.every((c, i) => sameColumn(c, newColumns[i]!))
  ) {
    const added = newColumns.at(-1)!;
    // Catalog defaults prove literal/NULL initialization; hidden/generated columns do not qualify.
    // CHECK validation is independently rejected by its nested quick_check authorization.
    return added.hidden === 0 && added.primaryKey === 0 && constantDefault(added.defaultValue);
  }
  if (newColumns.length !== oldColumns.length) {
    return false;
  }
  const renamed = oldColumns.filter((c, i) => c.name !== newColumns[i]!.name).length;
  return (
    oldColumns.every((c, i) => sameColumn(c, newColumns[i]!, false)) &&
    ((before.name !== after.name && renamed === 0) || (before.name === after.name && renamed === 1))
  );
}
function changedTables(before: SqliteCatalog, after: SqliteCatalog): Set<string> {
  const changed = new Set<string>();
  for (const table of [...before.tables, ...after.tables]) {
    const key = tableKey(table.schema, table.name);
    const old = before.tables.find((t) => tableKey(t.schema, t.name) === key);
    const next = after.tables.find((t) => tableKey(t.schema, t.name) === key);
    if (!old || !next || JSON.stringify(old) !== JSON.stringify(next)) {
      changed.add(key);
    }
  }
  for (const index of [...before.indexes, ...after.indexes]) {
    const old = before.indexes.find((i) => i.schema === index.schema && i.name === index.name);
    const next = after.indexes.find((i) => i.schema === index.schema && i.name === index.name);
    if (!old || !next || JSON.stringify(old) !== JSON.stringify(next)) {
      changed.add(tableKey(index.schema, index.table));
    }
  }
  return changed;
}

export function classifyMigrationBulkAccess(
  observation: SqliteMigrationObservation,
  range: SqliteMigrationRange,
): MigrationBulkAccessReceipt {
  const receipt: MigrationBulkAccessReceipt = {
    violations: [],
    integrityChecks: [...observation.integrityChecks],
    coverageFailures: [...observation.coverageFailures],
  };
  // Resolve rename lineage before classifying: staging writes/index builds preceding publication
  // must inherit the settled bulk role. Names are scoped by physical connection and schema.
  const roles = new Map<string, Set<string>>();
  const renames: Array<[string, string]> = [];
  const keyFor = (s: ObservedSqliteStatement, schema: string, name: string) =>
    `${s.databaseId}\0${tableKey(schema, name)}`;
  for (const statement of observation.statements) {
    for (const table of [...statement.before.tables, ...statement.after.tables]) {
      if (
        bulkTables.has(table.name.toLowerCase()) ||
        table.type === "virtual" ||
        table.type === "shadow"
      ) {
        const key = keyFor(statement, table.schema, table.name);
        roles.set(key, new Set([table.name]));
      }
    }
    for (const action of actions(statement).filter((a) => a.action === 26)) {
      const old = statement.before.tables.find(
        (t) => t.schema === action.argument1 && t.name === action.argument2,
      );
      if (!old) {
        receipt.coverageFailures.push(
          `Cannot resolve intermediate ALTER TABLE source from settled catalogs: ${statement.sql}`,
        );
        continue;
      }
      if (statement.after.tables.some((t) => t.schema === old.schema && t.name === old.name)) {
        continue;
      }
      const candidates = statement.after.tables.filter(
        (t) =>
          t.schema === old.schema &&
          t.type === old.type &&
          t.rootpage === old.rootpage &&
          !statement.before.tables.some((b) => b.schema === t.schema && b.name === t.name),
      );
      if (candidates.length === 1) {
        renames.push([
          keyFor(statement, old.schema, old.name),
          keyFor(statement, old.schema, candidates[0]!.name),
        ]);
      } else {
        receipt.coverageFailures.push(`Cannot resolve ALTER TABLE lineage: ${statement.sql}`);
      }
    }
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const [a, b] of renames) {
      const merged = new Set([...(roles.get(a) ?? []), ...(roles.get(b) ?? [])]);
      if (
        merged.size &&
        (merged.size !== roles.get(a)?.size || merged.size !== roles.get(b)?.size)
      ) {
        roles.set(a, merged);
        roles.set(b, merged);
        propagated = true;
      }
    }
  }
  for (const statement of observation.statements) {
    if (statement.ownerIntegrity) {
      continue;
    }
    const auth = actions(statement);
    const catalogs = [statement.before, statement.after];
    const role = (schema: string | null, name: string | null): Set<string> => {
      if (!name) {
        return new Set();
      }
      const found = new Set(roles.get(keyFor(statement, schema || "main", name)));
      // VACUUM copies and attached/TEMP aliases cannot launder an exact canonical role.
      if (bulkTables.has(name.toLowerCase())) {
        found.add(name);
      }
      if (schema && !catalogs.some((c) => c.tables.some((t) => t.schema === schema))) {
        // Native transient copy schemas (notably VACUUM) are absent after settlement.
        for (const table of catalogs.flatMap((c) => c.tables).filter((t) => t.name === name)) {
          for (const inherited of roles.get(keyFor(statement, table.schema, table.name)) ?? []) {
            found.add(inherited);
          }
        }
      }
      for (const catalog of catalogs) {
        for (const index of catalog.indexes) {
          if (index.name === name && (!schema || index.schema === schema)) {
            for (const table of roles.get(keyFor(statement, index.schema, index.table)) ?? []) {
              found.add(table);
            }
          }
        }
      }
      return found;
    };
    const add = (tables: Iterable<string>, reason: string) => {
      for (const table of tables) {
        if (
          !receipt.violations.some(
            (v) => v.table === table && v.reason === reason && v.sql === statement.sql,
          )
        ) {
          receipt.violations.push({
            store: range.store,
            fromVersion: range.fromVersion,
            toVersion: range.toVersion,
            table,
            reason,
            sql: statement.sql,
          });
        }
      }
    };
    for (const action of auth) {
      const operation = rowActions.get(action.action);
      if (operation) {
        const table = action.action === 1 ? action.argument2 : action.argument1;
        add(role(action.schema, table), `Executed SQLITE_${operation} bulk-data intention`);
      }
      if (
        action.action === 19 &&
        /^(?:integrity_check|quick_check|foreign_key_check)$/iu.test(action.argument1 ?? "")
      ) {
        const tables = action.argument2
          ? role(action.schema, action.argument2)
          : new Set(catalogs.flatMap((c) => c.tables.flatMap((t) => [...role(t.schema, t.name)])));
        add(tables, `Migration-owned PRAGMA ${action.argument1} bulk validation`);
      }
      if (action.action === 26) {
        const before = statement.before.tables.find(
          (t) => t.schema === action.argument1 && t.name === action.argument2,
        );
        const after = statement.after.tables.find(
          (t) =>
            t.schema === action.argument1 &&
            (t.name === action.argument2 ||
              (before && t.rootpage === before.rootpage && t.type === before.type)),
        );
        const tables = role(action.argument1, action.argument2);
        if (tables.size && (!before || !after || !constantAlter(before, after, auth))) {
          const validates = auth.some(
            (a) => a.action === 19 && /^(?:quick_check|integrity_check)$/iu.test(a.argument1 ?? ""),
          );
          const dropsColumn = before && after && after.columns.length < before.columns.length;
          if (validates || dropsColumn) {
            add(tables, "ALTER TABLE rewrites or validates bulk rows");
          } else {
            receipt.coverageFailures.push(
              `Cannot prove constant bulk ALTER TABLE for ${[...tables].join(", ")}: ${statement.sql}`,
            );
          }
        }
      }
    }
    const touched = changedTables(statement.before, statement.after);
    if (range.afterMinReader > range.beforeMinReader) {
      for (const key of touched) {
        const [schema, name] = key.split("\0");
        add(
          role(schema!, name!),
          `Bulk schema touch with reader-floor rise ${range.beforeMinReader}→${range.afterMinReader}`,
        );
      }
    }
    // A batch is never source-split. Multiple ALTER intentions can hide an intermediate
    // rewrite even when the final catalog resembles a constant change.
    const uniqueAlters = new Set(auth.filter((a) => a.action === 26).map((a) => JSON.stringify(a)));
    const compiledAlters = Math.max(
      statement.preparedAuthorizations.filter((a) => a.action === 26).length,
      statement.executedAuthorizations.filter((a) => a.action === 26).length,
    );
    if (
      (uniqueAlters.size > 1 || compiledAlters > 1) &&
      [...touched].some((key) => {
        const [schema, name] = key.split("\0");
        return role(schema!, name!).size > 0;
      })
    ) {
      receipt.coverageFailures.push(
        `Cannot prove intermediate bulk ALTER effects in one native execution: ${statement.sql}`,
      );
    }
    if (touched.size && !auth.some((a) => schemaActions.has(a.action))) {
      receipt.coverageFailures.push(
        `Catalog changed without schema authorization coverage: ${statement.sql}`,
      );
    }
  }
  receipt.coverageFailures = [...new Set(receipt.coverageFailures)];
  return receipt;
}

export function assertMigrationBulkSafe(
  observation: SqliteMigrationObservation,
  range: SqliteMigrationRange,
): MigrationBulkAccessReceipt {
  const receipt = classifyMigrationBulkAccess(observation, range);
  if (receipt.violations.length || receipt.coverageFailures.length) {
    throw Object.assign(
      new Error(
        `Migration bulk-access guard failed for ${range.store} ${range.fromVersion}→${range.toVersion} (reader floor ${range.beforeMinReader}→${range.afterMinReader}): ${JSON.stringify(receipt)}`,
      ),
      { receipt },
    );
  }
  return receipt;
}
