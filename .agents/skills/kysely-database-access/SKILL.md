---
name: kysely-database-access
description: Use when adding, reviewing, or refactoring OpenClaw Kysely database access, native node:sqlite stores, generated DB types, SQLite schemas, migrations, raw SQL, transactions, or database access best practices.
---

# Kysely Database Access

Use this skill for OpenClaw database code that touches Kysely, `node:sqlite`,
generated DB types, SQLite schemas, migrations, or store/query design.

## Read First

- `docs/concepts/kysely.md` for the repo's Kysely rules and examples.
- The owning subtree `AGENTS.md`, if present.
- Relevant local Kysely source/types under `node_modules/kysely/dist/esm/...`
  before assuming dialect behavior, result types, transactions, plugins, or raw
  SQL semantics.
- For codegen behavior, inspect `scripts/generate-kysely-types.mjs` and
  `kysely-codegen --help` from the repo package manager.

## Official Docs Cross-Check

When the behavior matters, verify against current Kysely docs/source before
patching:

- Generating types: production apps should keep schema types aligned with the
  database through code generation.
- Data types: TypeScript types do not affect runtime values; the driver decides
  runtime values, and Kysely returns what the driver returns unless a plugin
  transforms results.
- Raw SQL: the `sql` tag can execute full raw SQL and embed snippets into
  builders. Prefer typed builders/helpers when they express the same thing.
- Reusable helpers: take `Expression<T>` or an `ExpressionBuilder` when wrapping
  SQL expressions; alias helper expressions explicitly in `select`. Extract a
  helper only when it quarantines raw SQL, removes meaningful duplication, or
  preserves a tricky inferred type.
- Split build/execute only at deliberate boundaries. Compiled-query execution
  is useful for native sync adapters, but keep plugin/result-transform behavior
  in mind.
- Migrations: Kysely migration files run without a schema type. In OpenClaw,
  prefer the committed SQL-source-of-truth path unless a new owner explicitly
  needs Kysely-managed migrations.
- Plugins: plugins can transform queries and results. Any sync shortcut that
  bypasses Kysely's async executor needs a documented invariant or tests.

## Default Workflow

1. Identify the owner boundary:
   - Core state DB: `src/state/*`
   - Per-agent DB: `src/state/openclaw-agent-*`
   - Feature store: owning `*.sqlite.ts` module
   - Plugin-owned state: plugin/module owner, not generic core
2. Inspect the schema source first:
   - `*.sql` is the source of truth when generated schema/types exist.
   - Generated `*.generated.*` files are outputs, not hand-edit targets.
3. Prefer Kysely builders for normal CRUD:
   - `selectFrom`, `insertInto`, `updateTable`, `deleteFrom`
   - `executeTakeFirst`, `executeTakeFirstOrThrow`, `execute`
   - `eb.fn.countAll`, `eb.fn.count`, `eb.fn.coalesce` for common functions
   - Keep compile-time Kysely reference literals such as `"host"` and
     `"flow_id as flowId"` when they are clearer than constants; they are
     type-checked by Kysely.
   - Let Kysely infer selected row shapes. Do not pass broad row generics to
     sync helpers for normal builder queries.
   - Treat `executeSqliteQuerySync<Row>(db, builder)` and
     `executeSqliteQueryTakeFirstSync<Row>(db, builder)` as a smell: the generic
     can lie about selected columns. Use no generic for builders; use an exact
     raw boundary helper for raw SQL.
   - For finite public query presets, use a preset-to-row type map plus a union
     boundary type instead of `Record<string, ...>`.
4. Keep raw SQL deliberate:
   - Good: pragmas, virtual tables, FTS, SQLite JSON functions, migrations,
     `sqlite_master`, compact repeated expressions.
   - Bad: raw `COUNT(*)` or dynamic SQL where Kysely has a typed builder shape.
   - Use `${value}` parameters; use `sql.ref` / `sql.table` only for validated,
     closed-set identifiers.
   - Do not feed unconstrained runtime `string` values into table/column/group/
     order/identifier positions. Narrow them to local unions or generated table
     keys first.
   - Prefer `eb.fn`, `eb.lit`, `eb.ref`, and expression callbacks for scalar
     SQL such as `count`, `coalesce`, `max`, `exists`, and constant selections.
5. Align TypeScript with real driver values:
   - Kysely does not coerce runtime values.
   - Native `node:sqlite` returns BLOB columns as `Uint8Array`; convert with
     `Buffer.from(...)` only at API boundaries that need Buffer helpers.
   - Keep JSON/text/timestamp parsing at module boundaries.
6. Decide migration need from shipped state:
   - Unshipped schema/type cleanup: no SQLite migration.
   - Shipped canonical schema change: add the appropriate migration or
     doctor/fix repair path with tests.
   - Legacy config repair belongs in doctor/fix paths, not startup surprises.

## Codegen

For committed SQL-backed generated types:

```bash
pnpm db:kysely:gen
pnpm db:kysely:check
```

The repo maps SQLite `blob` to `Uint8Array` through `kysely-codegen`
`--type-mapping`. Do not post-process generated files by hand; change the
generator or SQL source and regenerate.

## Native SQLite Guardrails

- Use `getNodeSqliteKysely(db)` and sync helpers from `src/infra/kysely-sync.ts`
  for `DatabaseSync` stores.
- Keep sync helper result types derived from `CompiledQuery<Row>` / Kysely
  builders. Explicit helper generics are for raw SQL or external boundaries,
  not for widening a typed builder result into a generic record.
- Keep the native dialect in `src/infra/kysely-node-sqlite.ts` aligned with
  Kysely's SQLite driver structure: single connection, mutex, SQLite adapter,
  SQLite query compiler, SQLite introspector.
- Use `StatementSync.columns().length` behavior for row-returning statements;
  do not parse SQL verbs.
- Return `insertId` only for changed Kysely insert nodes. Raw insert SQL and
  ignored inserts must not expose stale `lastInsertRowid`.
- Remember that sync execution compiles through Kysely but bypasses async
  `executeQuery` result plugins/logging. If plugins enter this path, add tests
  or a documented invariant.

## Tests

Pick the smallest proof that covers the touched surface:

```bash
pnpm db:kysely:check
pnpm lint:kysely
pnpm test src/infra/kysely-node-sqlite.test.ts
pnpm test <owning-store>.test.ts
pnpm tsgo:core
```

Add or update focused tests for:

- generated type/runtime mismatches
- native dialect metadata (`insertId`, `numAffectedRows`, row-returning SQL)
- transactions/savepoints
- BLOB and JSON boundary conversions
- schema/codegen drift
- type inference contracts for sync helpers and public query result maps
- negative type contracts with `@ts-expect-error` for important column/preset
  mistakes
- public store behavior, not just private SQL shape

## Helper Extraction

Good helpers:

- `readSqliteNumberPragma(db, pragma)` style helpers with a closed union for
  PRAGMA names.
- Raw-expression helpers that accept Kysely expressions/refs instead of raw
  column strings.
- Public query preset maps that preserve exact row types at the API boundary.

Avoid helpers that:

- Wrap obvious Kysely literals just to avoid strings.
- Take generic `string` table/column/order names.
- Return heavily generic query builders that are harder to type than the query
  they hide.

## Avoid

- Do not introduce ORM/repository layers or hidden relation loading.
- Do not make root dependencies for plugin-only database needs.
- Do not migrate everything to raw SQL or everything to builders for purity.
- Do not hand-edit generated DB types.
- Do not hide finite query result shapes behind `Record<string, ...>` just to
  make JSON output convenient; use exact row unions or map at the boundary.
- Do not replace every Kysely string literal with constants for aesthetics; fix
  dynamic identifiers, raw SQL assertions, and public result boundaries instead.
- Do not add broad cache layers to hide repeated query/discovery work; carry the
  known runtime fact earlier when possible.
