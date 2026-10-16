---
summary: "Select experimental PostgreSQL storage, understand SQLite anchors, and observe database work"
read_when:
  - Configuring PostgreSQL for a Gateway
  - Backing up a PostgreSQL store and its SQLite anchor
  - Counting database statements or worker requests
title: "Database engines (experimental)"
doc-schema-version: 1
---

OpenClaw uses SQLite by default. The experimental PostgreSQL adapter lets one
Gateway keep supported stores in PostgreSQL while other stores stay on SQLite.
The adapter owns connection setup, schema admission, transaction behavior, and
commit notifications; stores keep their existing data and operation contracts.

Daemon runtime pins stay local on every engine, in
`<state-root>/control/services.sqlite`. The daemon owner supplies typed runtime
intent to the macOS app without requiring a running Gateway or PostgreSQL
connection. Shared-state engine selection does not move this store.
No release stored runtime pins in PostgreSQL shared state, so PostgreSQL installs have no legacy pin source to migrate.

## Configure PostgreSQL

Use a PostgreSQL database and a role that can create schemas
and tables. PostgreSQL 16 or newer and UTF8 server and client encoding are required;
admission checks these once per physical store load. No extensions are installed
by the engine. Put its connection DSN in a secret, then configure a SecretRef:

```json5
{
  database: {
    engine: "postgres",
    postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
      schemaPrefix: "openclaw",
    },
  },
}
```

Provide `OPENCLAW_DATABASE_DSN` in the Gateway's environment through your secret
manager. It is the secret referenced by this example, not an engine-selection
environment variable. [File and exec references](/gateway/secrets/secretref-contract)
are also supported. Store-backed references are rejected because resolving them
requires the shared database that this connection must open. Use an env, file or
exec SecretRef instead; `openclaw doctor` reports invalid connection refs.
The host resolves the secret and passes the connection to
database workers; workers do not resolve SecretRefs. Treat the DSN as a credential
and do not put it in logs or diagnostic captures.

Restart the Gateway after changing the engine, then run `openclaw doctor` to see
each store's selected engine. Doctor warns that PostgreSQL is experimental and
that stores without a PostgreSQL schema remain on SQLite.

| Field                            | Default      | Meaning                                                                                                                                                          |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.engine`                | `"sqlite"`   | `"sqlite"` or `"postgres"`. PostgreSQL applies to every registered store that supplies a PostgreSQL schema.                                                      |
| `database.postgres.connection`   | None         | Required for PostgreSQL. A DSN string or env/file/exec SecretRef; store-backed refs are rejected.                                                                |
| `database.postgres.schemaPrefix` | `"openclaw"` | Prefix for new store schemas: 1–27 lowercase letters, digits, or underscores, starting with a letter or underscore. Existing anchors keep their recorded schema. |

Shared state, agent databases, Workboard, Logbook, and Team Reports currently support PostgreSQL. The Gateway resolves
the selected engine before its first shared-state read and retains that immutable
selection for the lifetime of the process. Reader, writer, and lease workers receive
the resolved selection explicitly; they never resolve the connection again. A
different selection in the same process is refused. Restart the process after
changing the connection or engine.

Offline port commands scope their source and target selections to each worker
task, including resource cleanup, so reusing an idle worker does not change the
Gateway's process selection.

Stores without PostgreSQL support still use SQLite. Incognito storage remains memory-only.
The supported PostgreSQL families are:

- **Shared state:** runtime storage, bidirectional database ports, and
  matched backups. The provider covers the selected `state/openclaw.sqlite` and
  retained Voice Call state roots, including explicitly configured store paths
  and disabled plugin entries. Matrix account/token roots are excluded from this
  provider; their discovery and custody belong to the Matrix account-root lane.
- **Agent databases:** fresh agent stores, including shared-main auth and explicit
  agent directories, use the selected engine through the existing agent workers.
  Transcript payloads are stored as plain JSON on PostgreSQL. Transcript text search
  uses the engine's admitted full-text capability and requires `unaccent`.
  Memory indexing remains unavailable until the memory owner supports PostgreSQL;
  requests fail with `DATABASE_SEARCH_CAPABILITY_UNAVAILABLE`.
  Existing SQLite agent stores cannot switch engines; agent ports and backup
  providers are not available yet. PostgreSQL agent schemas support current-version
  bootstrap only and reject schema drift before exposing the store.
- **Workboard:** runtime storage, bidirectional database ports, and matched backups.
- **Logbook:** runtime frames, batches, observations, cards, and standups;
  bidirectional database ports; and matched backups. Frame images remain local
  file artifacts under `logbook/frames`. Ports preserve their stored paths and
  leave the files in place. Backups include that directory alongside the database
  export and anchor; retain it when restoring or moving an installation.
- **Team Reports:** saved reports, person-day counts, and run history;
  bidirectional database ports; and matched backups. Collected activity is
  session-local scratch and is not exported or backed up.

A supported store never silently falls back to SQLite when its PostgreSQL
connection or admission fails.

Doctor can acquire offline maintenance custody and run data-only state migrations
on PostgreSQL. A live or unverifiable Gateway owner still prevents maintenance;
state writes use the existing PostgreSQL writer advisory lock. Registered state
schema migrations retain a full, exact state-family backup and matching anchor
before the version runner begins. Each migration supplies its predecessor backup
descriptor; a missing descriptor refuses the migration. The engine validates the exact
destination schema before commit and publication. Failed migrations roll back
transactionally, while their `.postgres.bak` exports remain available for recovery.

Use `openclaw database port` to move existing supported data between engines.
Changing `database.engine` alone does not migrate existing data. Omitting
`database` preserves the SQLite default, so ordinary updates require no
configuration or data migration.

Existing SQLite shared state and agent databases refuse a PostgreSQL selection and name
`openclaw database port` as the migration path. The port command handles
current-schema shared state, Workboard, Logbook, and Team Reports. Upgrade older
shared state with `openclaw doctor --fix` using a compatible binary before porting.
Agent porting is not available yet; keep existing agent stores on SQLite.
Do not remove existing data to switch engines.

## Search on PostgreSQL

The experimental engine search contract supports native PostgreSQL full text,
literal trigram contains, and exact cosine search. Agent transcript text search
uses this contract; agent memory still follows the support matrix above.
It does not enable PostgreSQL for an unported store.

For a store that declares search indexes, install these extensions in the
database before opening it. The default extension namespace is `public`:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
```

`unaccent` is required for full text, `pg_trgm` for a declared trigram index,
and `vector` for semantic search. Extensions are database-wide; the store's
schema declaration identifies their namespace when it differs from `public`.
The engine checks availability and privileges once at store admission. It never
installs extensions automatically. An unavailable capability refuses admission
with its extension name and operator SQL; it does not return empty search results
or switch storage engines. Extension installation may require a database
administrator. The runtime role needs `CREATE` in the store schema, or database
`CREATE` privilege when bootstrapping a new schema, plus ownership/access to its
tables, indexes, functions, and text-search configuration.

The existing explicit keyword-only memory setting is `memory.search.provider: "none"`
(or the corresponding agent-specific override). The engine's keyword-only schema
requires no pgvector extension and exposes no vector capability. The memory owner's
PostgreSQL integration is pending; this setting does not yet enable memory indexing. Disabling only the native vector
index is not a PostgreSQL JavaScript-scan fallback. An embedding-provider failure
does not silently authorize keyword-only PostgreSQL admission.

Full text uses a named `simple` plus `unaccent` configuration, a stored generated
`tsvector`, and GIN. Queries bind literal terms and compile conjunctions,
disjunctions, adjacent phrases, and final-lexeme prefixes. User text is never
interpreted as PostgreSQL query operators. Ranking uses `ts_rank_cd` with
normalization 2: scores are engine-local, higher is better, and ordering differs
from SQLite BM25. Tokenization also differs for punctuation, compound words, and
Unicode. Snippets use `ts_headline` only after a materialized, bounded candidate
selection, with a word budget of 2–48, a character cap of 500, and empty highlight markers. Trigram
contains uses its own GIN index and escaped literal `ILIKE`; it is not a universal
fallback for full-text queries.

Semantic search uses exact float32 `vector(n)` cosine distance, with model and
source eligibility in the same query before ordering and limit. The canonical
embedding remains its original little-endian binary64 BLOB; source-transaction
triggers maintain the derived float32 projection. Exact vectors support up to
16,000 dimensions. A dimension change requires a matching schema and a derived
index rebuild. There is no ANN, HNSW, IVFFlat, half-precision storage, or transfer
of the PostgreSQL corpus into JavaScript for per-query scoring.

Generated columns, GIN indexes, vector projection tables, trigger functions, and
the named text-search mappings participate in the store's exact schema-drift
fingerprint. Rebuilds run under the owning writer transaction. PostgreSQL search
remains experimental while product-flow conformance and agent storage cutover
are completed.

Managed-service documentation lists pgvector for Amazon RDS, Google Cloud SQL,
Neon, and Supabase, but this is not a tenant availability guarantee. RDS support
depends on the instance patch and extension version; Cloud SQL versions vary by
PostgreSQL major; Neon requires per-database enablement and version verification;
Supabase's setup guide does not guarantee a numeric version. Verify all required
extensions and privileges for the actual database.

## Port existing stores

Stop the Gateway first, through the service owner that normally manages it, and
stop embedded agents using the same state directory. The command refuses a live
owner and never stops or restarts services for you. Configure
`database.postgres.connection` before porting to PostgreSQL, leaving the current
`database.engine` unchanged until the command switches it.

```bash
openclaw database port --to postgres --dry-run
openclaw database port --to postgres
```

Port, backup, restore, and fingerprint operations share one database-family
provider registry. Each provider resolves its stores and supplies the generated
schema descriptor and expected PostgreSQL catalog. **Shared state, Workboard,
Logbook, and Team Reports are registered families.** Agent and Matrix-root
support are not enabled by this registry yet. An unrecognized PostgreSQL anchor
refuses the operation and names the supported families.
For separately installed plugins such as Team Reports, operations load the
selected installed plugin's schema and admission API. Keep the matching plugin
installed for port, backup, and restore. Preflight does not require absent
optional plugins.

The command inventories existing shared state, Workboard, Logbook, and Team Reports stores,
including disabled plugin stores. A real SQLite-to-PostgreSQL port initializes
missing shared state before capture so the config writer uses the same selected
store after the switch. It does not create missing plugin stores or port agent
databases. A dry run checks read-only
prerequisites and reports checks that still require private migration, copying,
or a PostgreSQL privilege probe. It creates no manifest, migrated copy, or target
namespace. Add `--json` for machine-readable results without connection strings
or row payloads.

The real operation retains exact original database and config captures under
`<stateDir>/recovery/database-port/<operation-id>/`. SQLite originals are verified
snapshots with WAL changes settled. PostgreSQL originals include a matched
anchor and exact SQLite export; these captures retain current rows without the
user-backup sanitizer. Config captures include the root file and its includes.
Keep this directory private and retain the complete set. Former PostgreSQL
namespaces are not dropped automatically.

All destination stores are privately migrated and verified before publication.
The command replaces each store atomically, switches config last while preserving
SecretRefs, environment references, and includes, then archives its completed
manifest with the captures. After success, start the Gateway through its service
owner.

An interrupted operation keeps startup blocked by
`<stateDir>/recovery/database-port/manifest.json`. Keep the Gateway stopped and
use that active manifest with one of:

```bash
openclaw database port --resume <stateDir>/recovery/database-port/manifest.json
openclaw database port --rollback <stateDir>/recovery/database-port/manifest.json
```

Resume revalidates the captured evidence and finishes the interrupted operation.
Rollback restores the entire original store and config set. These options are
mutually exclusive and cannot be combined with `--to` or `--dry-run`. Completed,
archived manifests are not an undo command after runtime has resumed.

To return to SQLite without losing writes accepted after a successful port, stop
the Gateway and run a new reverse port:

```bash
openclaw database port --to sqlite --dry-run
openclaw database port --to sqlite
```

Reverse-port before downgrading through a raw package manager such as npm, pnpm,
or Homebrew: those paths bypass `openclaw update` engine compatibility checks.
An old SQLite capture is historical and does not contain later PostgreSQL writes.
See the [CLI reference](/cli#database).

## Several Gateways on one PostgreSQL server

Several independent installations can share one PostgreSQL server. Each
installation must have its own state directory and exactly one Gateway.
Sharing one installation across Gateways, including failover and active-active
operation, is not supported: each store has one live owner.

### Recommended: one database per Gateway

Use a separate PostgreSQL database and connection DSN for each Gateway. This
provides the strongest isolation between installations. Install the required
search extensions in **each database**, as described in
[Search on PostgreSQL](#search-on-postgresql); extensions installed in one database
are not available in another. Each installation can use the default
`database.postgres.schemaPrefix` because their databases are separate.

A database administrator creates the databases and may need to install extensions.
The runtime role needs `CONNECT` and database `CREATE` privilege to bootstrap its
store schemas, plus ownership/access to its store objects and `USAGE` on the
extension schema.

### One database with separate namespaces

Give each Gateway a distinct `database.postgres.schemaPrefix`, such as
`installation_a` and `installation_b`. Each store gets a separate anchor UUID and
namespace; its writer advisory lock uses that UUID. Keep each local anchor with
its matching PostgreSQL namespace. Pairing one installation's anchor with another
installation's namespace refuses admission. Changing the configured prefix does
not move an existing anchor.

Install `unaccent`, `pg_trgm`, and `vector` once in the shared database's `public`
schema (or the explicitly declared extension schema). All installations reuse
those extensions; admission checks them and never recreates them. Text-search
configurations are schema-qualified, and generated columns, indexes, vector
projections, and functions belong to each store namespace.

The runtime role needs `CONNECT` on the shared database and database `CREATE`
privilege to bootstrap namespaces, plus ownership/access to its store objects and
`USAGE` on the extension schema. Use separate roles and schema grants when
installations also need a PostgreSQL permission boundary; schema prefixes alone
do not restrict a role's access.

## Isolation and durability

One Gateway owns each store. PostgreSQL does not enable multiple active owners of one store,
external writers, replication management, or connection-pool management.

Writers use `READ COMMITTED` and a transaction-scoped advisory lock derived from
the store identity. Every PostgreSQL write, including a single statement, uses
the adapter's `runTransaction` so it retains that lock and publishes its write
token. A single-statement read may use autocommit; multi-statement snapshot reads
use `REPEATABLE READ READ ONLY`. Connections
set `synchronous_commit=off` to match SQLite WAL with `synchronous=NORMAL`: a
server or operating-system crash can lose recently acknowledged commits. Backups
and recovery must account for that durability policy. The adapter sets generous
lock and statement timeouts once during connection setup; operations do not
change timeout settings individually.

## Anchors and backups

A PostgreSQL store keeps a small SQLite anchor at its usual local database path.
The anchor records the store UUID, engine, and PostgreSQL schema. New schemas use
`<schemaPrefix>_<store>_<uuid-prefix>`; moving the anchor preserves the identity.
PostgreSQL schema metadata must match the anchor's store UUID and expected schema
version. Admission checks run once per physical store per process load, and
workers and handles reuse the admitted facts. Confirmed commits and uncertain
commit outcomes invalidate cached store facts through the anchor's write token.

PostgreSQL catalog admission captures column types, nullability, exact defaults,
keys, CHECK expressions, index definitions (including partial predicates), and
trigger definitions and function bodies from the server in one consistent read.
Bootstrap and migrations record a fingerprint of these PostgreSQL-deparsed facts,
a hash of the generated DDL for the active schema, and the server major version.
Startup compares the live fingerprint and the build's DDL hash with that record.
A mismatch refuses admission and names the recovery step. After a server-major
upgrade, admission compares the live catalog with generated DDL in a temporary
namespace, removes that namespace, and records the new fingerprint only on a
match. Unsealed pilot/ported stores receive the same one-time comparison. These facts are separate from the anchor's SQLite
catalog. Ordinary data commits retain schema admission; schema owners publish
replacement facts after committed DDL. Optional SQLite WAL, checkpoint, and
page-reclamation work does not apply to PostgreSQL. Explicit SQLite integrity,
repair, and file-snapshot requests refuse with a PostgreSQL recovery instruction.

Runtime PostgreSQL queries run in workers. Physical open and boot migration code
may use the synchronous `withEngineStoreAdmission` scope from
`openclaw/plugin-sdk/database-engine-worker-runtime`; retaining a connection after
that scope ends does not authorize main-thread queries. The callback must remain
synchronous. Close remains available to settle resources. The store owner supplies
`openEngineStore` with `inspectSqlite(): { hasExistingData, hasEngineAnchor }`,
so partially initialized stores are also protected from an accidental engine
switch. See the canonical
[`admission scope`](https://github.com/openclaw/openclaw/blob/main/src/infra/database-engine/admission-scope.ts)
and [`engine opener`](https://github.com/openclaw/openclaw/blob/main/src/infra/database-engine/open.ts).

Use `openclaw backup create` to capture PostgreSQL stores together with the
SQLite stores that still hold the rest of the installation. PostgreSQL backup
requires the Gateway stopped. If it is running, the command refuses: “stop
through the service owner, then rerun.” It never stops the Gateway automatically.
This requirement also applies to generic local snapshots and Git backups when
their selected source is PostgreSQL. `openclaw backup sqlite` refuses a PostgreSQL
anchor and directs you to `openclaw backup create`.

A PostgreSQL backup contains a portable SQLite export image, the original anchor,
and a format-2 manifest. The export reads one `REPEATABLE READ READ ONLY` snapshot,
then applies the existing user-backup sanitizer before compaction and hashing.
The manifest records the backup profile, engine, store UUID, schema versions,
active fragments, allocation facts, artifact sizes, and hashes. It never records
the connection DSN. Active optional fragments come from the source catalog,
not from enabled-plugin configuration; a missing required fragment dependency
refuses the copy. Restore re-admits that same fragment set. Canonical triggers
are installed after loading rows, while declared derived projections are omitted
from copying and rebuilt by their owner before verification. Unknown triggers
and views refuse the operation. Owners can migrate an older SQLite source only
in the operation's private copy; the original capture remains intact. Shared-state
ports require the current schema and preserve absent optional fragments, including
Doctor-owned deletion history. Its persisted projection columns and tables are
canonical data, so they are retained rather than rebuilt. Exact captures keep
secrets and transient rows; user exports apply the existing shared-state sanitizer.
Restore uses normal owner admission, including PostgreSQL catalog drift checks.

Preserve the complete matched set: an anchor alone contains
no PostgreSQL rows. Existing format-1 SQLite backups remain readable.

PostgreSQL restore verifies the matched set, loads a fresh owned namespace, and
publishes its matching anchor only after verification. Keep the displaced
namespace until recovery is confirmed. User backups follow the usual
sanitization and credential-exclusion policy; they are not exact updater recovery
captures. See [Backups](/install/backups) and [Backup CLI](/cli/backup).

## Updates and target compatibility

Updates preserve each store's physical engine. Before database mutation, the
installed updater captures PostgreSQL rows and their matching anchor without
sanitization, alongside the existing exact SQLite captures. Recovery restores
PostgreSQL into a fresh owned namespace and publishes its matched anchor; the
migrated namespace remains available until recovery is confirmed. Changed state
or uncertain custody prevents automatic restore and retains the captures for
recovery. An update never silently ports a store or falls back to SQLite.

Release packages declare supported engines in the optional
`openclaw.databaseEngines` array in `package.json`, next to
`openclaw.updateAdmissionProtocol`. An absent array means `["sqlite"]`; the
admission protocol remains `1`. Only installations with a physical non-SQLite
store use this additional check. A target without `postgres` is refused before
mutation with a remedy: reverse-port to SQLite with the current compatible binary,
or stay on the current version. SQLite-only installations keep their existing
admission behavior. The installed driver owns this check; a candidate cannot
repair an older driver. See [Update admission](/cli/update#candidate-owned-admission).

## Limits and recovery

Startup checks the fixed `recovery/database-port/manifest.json` under the selected
state directory before CLI config snapshots and again after acquiring fresh
Gateway or embedded-writer custody. An absent manifest or valid completed
manifest permits startup. An incomplete, unreadable, malformed, or unknown
manifest refuses startup and identifies the recovery artifact. These checks do
not open a database. Keep the manifest and its captured originals intact, then
use `openclaw database port --resume <manifest>` or `--rollback <manifest>`.

Fresh stores bootstrap from generated PostgreSQL DDL at the current store schema
version. Older stores run owner-supplied consecutive forward migrations under the
PostgreSQL writer transaction and advisory lock. A failure rolls back the pending
steps and their metadata; admitted facts publish only after commit. Each step
compares its result with the generated destination DDL in a temporary namespace
before recording the DDL hash and live catalog fingerprint. A missing migration
refuses admission. Newer stores require a compatible binary, or a reverse port
with a compatible binary before downgrade. Never edit schema metadata to bypass
admission.

The generated shared-state `state.postgres.sql` and `fragment-*.postgres.sql`
files contain runtime DDL only. Their caller supplies the transaction and
`search_path`; no second wrapped copy is generated. For manual readiness checks,
see [applying the generated state DDL](/reference/database-schemas/storage-changes#shared-state-postgresql-schema-generation).
The generated agent DDL likewise leaves the transaction and search path to its owner.

PostgreSQL text cannot contain NUL characters. Values containing NUL fail with an
engine error. Search/vector capabilities remain store-specific; selecting an
engine does not add PostgreSQL support to an unported store.

| Failure                                   | Next step                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Missing or unresolved connection secret   | Configure `database.postgres.connection` and verify the SecretRef provider is available to the Gateway. |
| Unreachable PostgreSQL server             | Check the DSN, network access, role permissions, and server availability.                               |
| Store UUID mismatch                       | Restore the matching anchor and PostgreSQL schema; do not pair an anchor with another store.            |
| Newer schema or missing forward migration | Use a compatible OpenClaw binary; reverse-port with that binary before a downgrade.                     |
| Gateway running during PostgreSQL backup  | Stop through the service owner, then rerun the backup command.                                          |
| Update target lacks PostgreSQL support    | Stay on the current version or reverse-port with the current compatible binary before retrying.         |

## Observe database work

The engine boundary publishes Node.js `diagnostics_channel` events on
`openclaw.database.statement` and `openclaw.database.request`. Subscriptions are
isolate-local: statement events are emitted in the database worker, and request
events on the host. Subscribe in each process or worker you want to measure:

```js
import { channel } from "node:diagnostics_channel";

channel("openclaw.database.statement").subscribe((event) => {
  // Count by event.engine, or inspect event.durationMs and event.outcome.
});
```

Each connection execution call emits one statement event. Compound `exec` or
query SQL produces one event carrying the normalized compound text; observation
does not split SQL or execute extra queries. Each worker `scope.execute` request,
connection open, and connection close emits one host-side request event.
Both include `engine` (`"sqlite"` or `"postgres"`),
`threadId`, `outcome` (`"ok"` or `"error"`), and `durationMs`. Statement events
also include normalized `sql` with literals redacted; neither event includes
bindings. Request events count the worker boundary separately from the statements
that the request executes. This lets census tools compare both engines without
inferring them from SQL. When no subscriber is present, the boundary skips timing,
SQL normalization, and event construction.

See [Database schemas](/reference/database-schemas) for store ownership and schema
contracts, and [Configuration reference](/gateway/configuration-reference) for
the rest of the Gateway configuration.
