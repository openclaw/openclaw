---
summary: "OpenClaw conventions for Kysely queries, table types, transactions, raw SQL, and native SQLite adapters"
title: "Kysely best practices"
read_when:
  - You are adding or reviewing Kysely-backed storage code
  - You are changing the native node:sqlite Kysely dialect
  - You are deciding whether a SQLite store should use Kysely or direct SQL
---

Kysely is a type-safe SQL query builder. In OpenClaw, use it when a store needs
typed query composition, transactions, migrations, or enough repeated SQL that
builder-level structure reduces risk. Keep tiny one-off SQLite helpers on direct
`node:sqlite` when the builder adds more surface than value.

## Ground rules

- Keep Kysely as a query builder, not an ORM. Do not add repository layers,
  relation abstractions, lazy model objects, or hidden cross-table loading.
- Keep database types near the owning store. Prefer a small `Database` interface
  for the tables that module owns over a global schema that every feature
  imports.
- Make runtime ownership explicit. Root Kysely usage needs root dependency
  ownership metadata in `scripts/lib/dependency-ownership.json`.
- Treat the database driver as the runtime source of truth. Kysely's TypeScript
  types do not coerce values returned by the driver.
- Prefer explicit schema helpers and focused tests over clever inferred helpers
  that are hard to read after a month.

## Table Types

Use Kysely table types to describe the TypeScript contract for each column:

```ts
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type SessionRow = {
  id: string;
  createdAt: ColumnType<Date, string | undefined, never>;
  updatedAt: ColumnType<Date, string | undefined, string>;
  sequence: Generated<number>;
};

type Session = Selectable<SessionRow>;
type NewSession = Insertable<SessionRow>;
type SessionUpdate = Updateable<SessionRow>;
```

Guidelines:

- Use `Generated<T>` for database-generated IDs or counters.
- Use `ColumnType<Select, Insert, Update>` when insert/update types differ from
  selected runtime values.
- Align selected types with what the driver actually returns. If `node:sqlite`
  returns `number`, type the selected column as `number`; if a value is encoded
  as JSON text, type the selected value as `string` until parse code proves and
  narrows it.
- Keep raw JSON, enum, and timestamp parsing at module boundaries. Do not pretend
  Kysely changed the runtime value.

## Generating Types From SQL

Kysely does not generate TypeScript table types directly from a `.sql` file.
Use the SQL file as the schema source of truth, apply it to a disposable
database, then introspect that database with `kysely-codegen`.

For SQLite schema files:

```sh
tmp_db="$(mktemp -t openclaw-kysely-schema.XXXXXX.sqlite)" &&
trap 'rm -f "$tmp_db"' EXIT

sqlite3 "$tmp_db" < src/path/to/schema.sql

DATABASE_URL="$tmp_db" pnpm dlx \
  --package kysely-codegen \
  --package typescript \
  --package better-sqlite3 \
  kysely-codegen \
  --dialect sqlite \
  --type-mapping '{"blob":"Uint8Array"}' \
  --out-file src/path/to/db.generated.d.ts
```

For OpenClaw's committed global and per-agent schemas, use the repo wrapper:

```sh
pnpm db:kysely:gen
pnpm db:kysely:check
```

Rules:

- Generate `DB` types from a real database, not by parsing SQL text.
- Keep generated types in a clearly named file such as `db.generated.d.ts`.
- When runtime code needs the same schema, generate a small schema module from
  the same `.sql` file, for example `schema.generated.ts`. Do not copy/paste the
  schema into runtime store code.
- Do not hand-edit generated files. Change the SQL source, regenerate, and
  review the diff.
- Use the same command with `--verify` in CI or a local check when generated
  types are committed.
- Map SQLite `blob` columns to `Uint8Array` for native `node:sqlite` stores.
  `node:sqlite` returns BLOB values as `Uint8Array`; wrap them in
  `Buffer.from(...)` at API boundaries that need `Buffer` helpers.
- For OpenClaw's native `node:sqlite` runtime, keep codegen as a dev-time tool.
  The codegen command uses `better-sqlite3` only because `kysely-codegen`'s
  SQLite introspector loads that driver. The runtime adapter remains
  `src/infra/kysely-node-sqlite.ts`; do not add a second runtime driver only for
  generated types.

## Query Shape

Prefer fluent Kysely queries for normal CRUD:

```ts
await db
  .selectFrom("session")
  .select(["id", "updatedAt"])
  .where("id", "=", sessionId)
  .executeTakeFirst();
```

Use the result method that matches the contract:

- `executeTakeFirstOrThrow()` when absence is exceptional.
- `executeTakeFirst()` when absence is expected.
- `execute()` when multiple rows are valid.

Keep helpers composable:

- Return query builders or expressions from helpers; do not execute inside helper
  functions unless the helper name clearly says it performs IO.
- Accept a transaction-capable database object when work may run inside a
  transaction.
- Alias computed selections explicitly.
- Kysely reference strings such as `"host"`, `"path"`, and
  `"flow_id as flowId"` are acceptable when they are compile-time literals. They
  are checked against the `DB` type and usually read better than column constant
  indirection.
- Let Kysely carry selected row shapes through builder queries. Avoid passing a
  broad row generic to a sync execution helper when the builder already knows
  the result type; use exact boundary types or a mapper instead.
- Do not call `executeSqliteQuerySync<Row>(db, builder)` or
  `executeSqliteQueryTakeFirstSync<Row>(db, builder)` for normal builders. The
  generic can widen or lie about selected columns. Let the builder's
  `CompiledQuery<Row>` type flow into the sync helper.
- For finite public query presets, prefer a preset-to-row type map and exported
  union over a generic `Record<string, ...>` row shape.

## Raw SQL

Use Kysely's `sql` tag for raw SQL. Never concatenate user input into SQL
strings.

```ts
const result = await sql<{ name: string }>`
  select name from person where id = ${personId}
`.execute(db);
```

Rules:

- Type raw result rows with `sql<RowType>`.
- Interpolate values through `${value}` so the driver receives parameters.
- Use identifier helpers only for validated, closed-set identifiers. Prefer
  normal builder methods when the table or column is known at compile time.
- Do not pass unconstrained runtime `string` values as table, column, `groupBy`,
  `orderBy`, `sql.ref`, or `sql.table` identifiers. Narrow them to a local union
  or a `keyof` generated table type first.
- Raw snippets are fine for SQLite pragmas, virtual tables, FTS, JSON functions,
  and migrations, but wrap repeated raw expressions in typed helpers.
- Prefer `eb.fn.countAll`, `eb.fn.count`, `eb.fn.max`, `eb.fn.coalesce`,
  `eb.lit`, expression callbacks, and `eb.ref` substitutions before raw SQL for
  scalar expressions and constant selections.
- Run `pnpm lint:kysely` after touching Kysely-backed stores. It rejects raw
  identifier helpers, unreviewed typed raw SQL, `db.dynamic`, and sync-helper
  row generics at builder call sites.

## Helper Extraction

Extract helpers when they protect a boundary or carry a reusable typed concept:

- closed-set PRAGMA readers for tests, for example
  `readSqliteNumberPragma(db, "busy_timeout")`
- raw SQLite expression helpers that take Kysely expressions or `eb.ref(...)`
  values, not loose column strings
- public preset-to-row maps for finite query APIs
- JSON/BLOB/timestamp mappers at store boundaries

Avoid helpers that hide a single clear builder chain, replace every checked
literal with a constant, or accept generic table/column/order strings.

## Transactions

Use callback transactions for ordinary atomic work:

```ts
await db.transaction().execute(async (trx) => {
  await trx.insertInto("session").values(row).execute();
  await trx.insertInto("session_event").values(event).execute();
});
```

Kysely commits when the callback resolves and rolls back when it throws.

Use controlled transactions when you need manual savepoints:

```ts
const trx = await db.startTransaction().execute();
try {
  await trx.insertInto("session").values(row).execute();
  const afterSession = await trx.savepoint("after_session").execute();

  try {
    await afterSession.insertInto("session_event").values(event).execute();
  } catch {
    await afterSession.rollbackToSavepoint("after_session").execute();
  }

  await trx.commit().execute();
} catch (error) {
  await trx.rollback().execute();
  throw error;
}
```

Do not call `trx.transaction()` inside a transaction callback; Kysely does not
support that public API shape. Use `startTransaction()` plus savepoint methods
for nested rollback behavior.

## Native SQLite Dialect

OpenClaw owns `src/infra/kysely-node-sqlite.ts` so runtime code can use Kysely
with Node's native `node:sqlite` module without shipping a third-party adapter.

Adapter rules:

- Reuse Kysely's SQLite pieces: `SqliteAdapter`, `SqliteQueryCompiler`, and
  `SqliteIntrospector`.
- Keep the Node floor high enough for the `node:sqlite` APIs we call. The
  adapter relies on `StatementSync.columns()`, available in Node 22.16+ and
  Node 24+.
- Use `stmt.columns().length > 0` to distinguish row-returning statements from
  mutations. This is more robust than parsing SQL verbs because `RETURNING`,
  pragmas, CTEs, and raw SQL make verb heuristics brittle.
- Execute row-returning statements with `all()` or `iterate()`, and mutations
  with `run()`.
- Preserve the row type from `CompiledQuery<Row>` in sync execution helpers so
  native stores keep Kysely's inferred result shape after compilation.
- Do not blindly map `lastInsertRowid` to Kysely `insertId`. In `node:sqlite`,
  that value is connection-scoped and can be stale for updates or ignored
  inserts. Only return `insertId` for insert statements that changed rows.
- Close the `DatabaseSync` in `Driver.destroy()`.
- Use a single connection plus a mutex unless a store has a real concurrency
  design. SQLite write concurrency is limited; hidden pools usually add lock
  surprises.
- Compile savepoint names as identifiers, not string-interpolated SQL.

## Streaming

Use streaming only when result size can be meaningfully large. The native
SQLite adapter should use `StatementSync.iterate()` so rows are not materialized
through `all()` first.

Tests should prove streamed rows match ordered query results. If a future
adapter batches rows, honor Kysely's `chunkSize` contract and add a regression
test for it.

## Tests

Every Kysely-backed store or dialect change should have a focused test that uses
a real in-memory SQLite database when feasible.

Minimum coverage for the native adapter:

- builder `select`
- sync helper type inference for aliases, aggregates, and driver-specific values
- negative type assertions for important column/preset mistakes using
  `@ts-expect-error`
- raw row-returning SQL
- non-returning insert metadata
- `INSERT ... RETURNING`
- ignored insert and update do not expose stale `insertId`
- transaction rollback
- controlled savepoint rollback
- streaming query iteration
- lazy database factory and `onCreateConnection`

For store-level tests, assert behavior through public store methods first and
query internals only when the storage invariant itself is the contract.

## Upstream References

- [Kysely SQLite dialect](https://kysely-org.github.io/kysely-apidoc/classes/SqliteDialect.html)
- [Kysely data types](https://kysely.dev/docs/recipes/data-types)
- [Kysely raw SQL](https://kysely.dev/docs/recipes/raw-sql)
- [Kysely reusable helpers](https://kysely.dev/docs/recipes/reusable-helpers)
- [Kysely controlled transactions with savepoints](https://kysely.dev/docs/examples/transactions/controlled-transaction-w-savepoints)
- [Kysely compiled query execution](https://kysely.dev/docs/recipes/splitting-query-building-and-execution)
