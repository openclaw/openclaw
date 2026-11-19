import type { DatabaseSync } from "node:sqlite";
import type {
  SqliteColumnCatalog,
  SqliteForeignKeyCatalog,
  SqliteIndexListRow,
  SqliteIndexTermRow,
  SqliteSchemaCatalog,
  SqliteSchemaRow,
  SqliteTableListRow,
} from "../../src/infra/sqlite-schema-catalog-types.ts";
import { normalizeSchemaSql, quoteSqliteIdentifier } from "../../src/infra/sqlite-schema-sql.ts";

/** Build-time only: record the native catalog, including expression text and hidden columns. */
export function readSqliteSchemaCatalog(db: DatabaseSync): SqliteSchemaCatalog {
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name")
    .all() as Array<SqliteSchemaRow & { type: string; tbl_name: string }>;
  const options = db.prepare("PRAGMA main.table_list").all() as SqliteTableListRow[];
  const normalized = (row: SqliteSchemaRow): SqliteSchemaRow => ({
    name: row.name,
    sql: normalizeSchemaSql(row.sql),
  });
  return {
    tables: objects
      .filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"))
      .map((table) => {
        const quoted = quoteSqliteIdentifier(table.name);
        const tableOptions = options.find(
          (row) => row.schema === "main" && row.name === table.name,
        );
        if (!tableOptions) {
          throw new Error(`Missing SQLite table options for ${table.name}`);
        }
        const indexes = db.prepare(`PRAGMA main.index_list(${quoted})`).all() as Array<
          SqliteIndexListRow & { seq: number }
        >;
        return {
          name: table.name,
          sql: normalizeSchemaSql(table.sql),
          strict: tableOptions.strict,
          withoutRowid: tableOptions.wr,
          columns: db.prepare(`PRAGMA main.table_xinfo(${quoted})`).all() as SqliteColumnCatalog[],
          foreignKeys: db
            .prepare(`PRAGMA main.foreign_key_list(${quoted})`)
            .all() as SqliteForeignKeyCatalog[],
          indexes: indexes
            .map(({ name, origin, partial, unique }) => ({
              name,
              origin,
              partial,
              unique,
              sql: normalizeSchemaSql(
                objects.find((row) => row.type === "index" && row.name === name)?.sql ?? null,
              ),
              terms: db
                .prepare(`PRAGMA main.index_xinfo(${quoteSqliteIdentifier(name)})`)
                .all() as SqliteIndexTermRow[],
            }))
            .toSorted((left, right) => left.name.localeCompare(right.name)),
          triggers: objects
            .filter((row) => row.type === "trigger" && row.tbl_name === table.name)
            .map(normalized),
        };
      }),
    views: objects
      .filter((row) => row.type === "view")
      .map((view) => ({
        name: view.name,
        sql: normalizeSchemaSql(view.sql),
        columns: db
          .prepare(`PRAGMA main.table_xinfo(${quoteSqliteIdentifier(view.name)})`)
          .all() as SqliteColumnCatalog[],
        triggers: objects
          .filter((row) => row.type === "trigger" && row.tbl_name === view.name)
          .map(normalized),
      })),
  };
}
