---
summary: "Select SQLite or PostgreSQL storage, understand local anchors, and observe database work"
read_when:
  - Configuring PostgreSQL for a Gateway
  - Backing up a PostgreSQL store and its SQLite anchor
  - Counting database statements or worker requests
title: "Database engines"
doc-schema-version: 1
---

OpenClaw uses SQLite by default. PostgreSQL is a supported alternative for the
five configurable families on qualified PostgreSQL 16–18 runtimes. One Gateway
can keep those stores in PostgreSQL while other stores stay on SQLite.
The adapter owns connection setup, schema admission, transaction behavior, and
commit notifications; stores keep their existing data and operation contracts.

For provisioning, first boot, migration, and recovery procedures, see the
[PostgreSQL operator guide](/gateway/postgresql). It also describes the current
[support matrix](/gateway/postgresql#support-matrix), including unqualified
server versions and native clients. It also records the exact
[published-stable upgrade scope](/gateway/postgresql#published-stable-upgrade-qualification).
Configured engine and search choices are supported.

Daemon runtime pins stay local on every engine, in
`<state-root>/control/services.sqlite`. The daemon owner supplies typed runtime
intent to the macOS app without requiring a running Gateway or PostgreSQL
connection. Shared-state engine selection does not move this store.
No release stored runtime pins in PostgreSQL shared state, so PostgreSQL installs have no legacy pin source to migrate.

Managed-update notifications use the selected shared-state engine. PostgreSQL
handoffs report through the running Gateway, or through an admitted offline owner
while it is stopped; the anchor never stores restart notifications. The local
handoff lease still owns service recovery when PostgreSQL is unavailable. A missed
notification is reported in the handoff log without suppressing recovery.
SQLite handoffs retain their direct-file notification path, including recovery
through an older installed runtime.

## Configure PostgreSQL

Use a PostgreSQL database and a role that can create schemas
and tables. PostgreSQL 16 or newer and UTF8 server and client encoding are required;
admission checks these once per physical store load. PostgreSQL 16–18 are qualified;
other admitted majors remain experimental pending full conformance. See the
[server-major evidence](/gateway/postgresql#server-major-qualification). No extensions
are installed by the engine. Put its connection DSN in a secret, then configure a SecretRef:

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
environment variable. Env, [file, and exec references](/gateway/secrets/secretref-contract)
are qualified for CLI and Gateway use. Store-backed references are
rejected because resolving them requires the shared database that this connection
must open. Use an env, file or
exec SecretRef instead; `openclaw doctor` reports invalid connection refs.
The host resolves the secret and passes the connection to
database workers; workers do not resolve SecretRefs. Treat the DSN as a credential
and do not put it in logs or diagnostic captures.

The following connection surfaces are qualified on PostgreSQL 17. See the
[connection qualification and setup](/gateway/postgresql#tls-and-exec-connection-qualification)
for the server and provider configuration.

| Connection surface | Support   | Verified configuration                                                                                                                                                |
| ------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS DSN            | Supported | `sslmode=verify-full` with an absolute `sslrootcert` path; certificate-chain and hostname verification, invalid-certificate refusal, and TLS-only server enforcement. |
| Exec SecretRef     | Supported | CLI and Gateway host resolution, worker propagation, no DSN persistence in config or diagnostics, and refusal on provider failure or empty output.                    |

Restart the Gateway after changing the engine, then run `openclaw doctor` to see
the default, override, and effective engine for each family. These are configured
choices, not evidence that a store has opened. Doctor warns when a
store has an engine mismatch, missing capability or other actionable problem;
selecting PostgreSQL alone is not a warning.

| Field                            | Default      | Meaning                                                                                                                                                            |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database.engine`                | `"sqlite"`   | Default `"sqlite"` or `"postgres"` for supported families. Families without PostgreSQL support remain on SQLite.                                                   |
| `database.families.<id>.engine`  | Inherit      | Override for `state`, `agent`, `workboard`, `logbook`, or `team-reports`. Each override requires `engine`; explicit unsupported PostgreSQL overrides are rejected. |
| `database.postgres.connection`   | None         | Required when any effective family uses PostgreSQL. A shared DSN string or env/file/exec SecretRef; store-backed refs are rejected.                                |
| `database.postgres.schemaPrefix` | `"openclaw"` | Prefix for new store schemas: 1–27 lowercase letters, digits, or underscores, starting with a letter or underscore. Existing anchors keep their recorded schema.   |

Shared state, agent databases, Workboard, Logbook, and Team Reports support PostgreSQL.
Before its first shared-state read, the Gateway resolves the effective family
map and, if needed, the shared PostgreSQL connection once on the host. Reader,
writer, and lease workers receive that immutable selection explicitly. Plugin
stores retain their family's boot choice across close and reopen. A different
family map, connection, or prefix in the same process is refused; restart after
changing them. When all effective families use SQLite, an unused PostgreSQL
connection is not resolved.

Offline port commands scope their source and target selections to each worker
task, including resource cleanup, so reusing an idle worker does not change the
Gateway's process selection.

Stores without PostgreSQL support still use SQLite. Incognito storage remains memory-only.
The supported PostgreSQL families are:

- **Shared state:** runtime storage, bidirectional database ports, and
  matched backups. The provider covers the selected `state/openclaw.sqlite` and
  retained Voice Call state roots, including explicitly configured store paths
  and disabled plugin entries. Matrix account/token roots also belong to this
  family, with one local anchor and PostgreSQL namespace per root.
- **Agent databases:** fresh agent stores, including shared-main auth and explicit
  agent directories, use the selected engine through the existing agent workers.
  Transcript payloads are stored as plain JSON on PostgreSQL. Transcript text search
  uses the engine's admitted full-text capability and requires `unaccent`.
  Memory indexing, text/vector/hybrid search, status, forgetting, and derived-index
  reset use the selected engine. Memory search is supported with engine-local
  ranking; see the extension requirements and keyword-only mode below.
  Memory text and vector admission are owned by the memory engine. Port and backup
  validate its recorded search extensions against those owner definitions.
  Existing agent stores support bidirectional ports and matched backups, including
  retained registry paths and explicit session or agent directories. Older SQLite
  schemas migrate only in the port's private copy. Compressed transcript events
  become plain JSON on PostgreSQL; transcript search is rebuilt before publication.
  Rebuildable memory indexes are omitted. Their rebuild hook remains explicitly
  pending the memory owner's rebuild entry point; empty metadata requests reindexing.
  Canonical memory origins and
  tombstones remain intact. Duplicate-key voice JSON refuses the port with a hashed
  row locator. Cold archive references are retained; user backups embed their blobs.
  PostgreSQL agent schemas support current-version
  bootstrap and the schema 27 to 28 forward migration, and reject schema drift
  before exposing the store.
- **Workboard:** runtime storage, bidirectional database ports, and matched backups.
- **Logbook:** runtime frames, batches, observations, cards, and standups;
  bidirectional database ports; and matched backups. Frame images remain local
  file artifacts under `logbook/frames`. Ports preserve their stored paths and
  leave the files in place. Backups include that directory alongside the database
  export and anchor; retain it when restoring or moving an installation.
- **Team Reports:** saved reports, person-day counts, and run history;
  bidirectional database ports; and matched backups. Collected activity is
  session-local scratch and is not exported or backed up.

| Additional state store              | Engine selection                | Port and backup coverage                                                                                       |
| ----------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Matrix account and token-hash roots | Effective `state` family engine | Declared `matrix` resources, including retained and disabled accounts; separate anchor and namespace per root. |

Matrix uses the existing shared-state keyed-store API for sync, account metadata,
recovery keys, and serialized crypto IndexedDB state. The SDK's in-memory
IndexedDB snapshot is persisted in that same root; it does not create another
persistent IndexedDB file. Changing the `state` engine requires porting every
retained root. An unsupported or unreadable database inside the declared resource
refuses the operation; preserve it and use the named repair or compatible version
before retrying. Doctor lists each root's physical engine and reports a mismatch
with the effective state-family engine.

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
Changing a default or family override does not migrate existing data. Omitting
`database` preserves the SQLite default, so ordinary updates require no
configuration or data migration.

Existing SQLite shared state and agent databases refuse a PostgreSQL selection and name
`openclaw database port` as the migration path. The port command handles
current-schema shared state, agent databases, Workboard, Logbook, and Team Reports. Upgrade older
shared state with `openclaw doctor --fix` using a compatible binary before porting.
Do not remove existing data to switch engines.

### Legacy data and PostgreSQL

Before porting SQLite stores to PostgreSQL, run `openclaw doctor --fix` while
those stores still use SQLite. The port preflight refuses pending declared
legacy migrations and names the repairs required before retrying the port.
A scoped `--family` port checks only migrations declared for that family.
This includes native Codex task assignments, Matrix inbound dedupe, and legacy
memory index sidecars.
Fresh Matrix account roots without legacy inbound-dedupe rows do not need a
migration completion receipt before porting.

These migrations are SQLite-only. On PostgreSQL, Doctor records that they are
not applicable instead of opening the local engine anchor as an application
database. A legacy memory sidecar found after selecting PostgreSQL stays
unchanged; normal memory reindexing rebuilds the index from authoritative memory
sources and may re-embed them. Keep those sources available.

<a id="mixed-engines-experimental" />

### Mixed engines

Use family overrides to choose engines for fresh stores, or a scoped port to move
existing stores. The five configurable
families share one `database.postgres` connection and schema prefix; per-family
connection and prefix options are not supported. The default still applies when
an override is omitted.

Keep agents and standalone plugin stores on SQLite while shared state,
including Matrix account roots, uses PostgreSQL:

```json5
{
  database: {
    engine: "sqlite",
    families: {
      state: { engine: "postgres" },
      agent: { engine: "sqlite" },
    },
    postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
    },
  },
}
```

Or keep shared state and agents on SQLite while a Workboard store uses
PostgreSQL:

```json5
{
  database: {
    engine: "sqlite",
    families: { workboard: { engine: "postgres" } },
    postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
    },
  },
}
```

Only the five listed families accept overrides. Unknown keys, fixed-local
families, missing `engine`, and per-family connection/prefix options are rejected.
Both SQLite and PostgreSQL agents are supported with either shared-state engine.
The PostgreSQL default includes agent databases. For example, keep agents local
while shared state uses PostgreSQL:

```json5
{
  database: {
    engine: "postgres",
    families: { agent: { engine: "sqlite" } },
    postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
    },
  },
}
```

To use PostgreSQL agents with SQLite shared state, select `database.engine: "sqlite"`
and `database.families.agent.engine: "postgres"`, with the same PostgreSQL connection
configuration. Plugin families inherit the default unless explicitly overridden.
Quarantine, managed-update, and package-activation safety journals stay local
SQLite. The local client credential store is also captured as a fixed-local
resource; it does not belong to an engine family. Daemon runtime pins do not acquire engine overrides;
incognito remains memory-only.

An override applies to the whole family: all shared-state fragments together,
all agent databases together, or the named plugin store. Admission and anchors
remain per physical store. Existing SQLite content refuses a PostgreSQL choice,
and a PostgreSQL anchor refuses SQLite; never remove an anchor to switch engines.
Changing an existing family's engine requires an offline port and a Gateway
restart. Configure the shared connection first, leave the current engine choice
unchanged, then port one family at a time:

```bash
openclaw database port --family workboard --to postgres --dry-run
openclaw database port --family workboard --to postgres
openclaw database port --family state --to postgres
openclaw database port --family workboard --to sqlite
```

Each operation ports every existing physical store of that family, including
retained stores. It publishes only that family's override after verifying the
copies; the default and other families remain unchanged. When the destination
matches the default, the command removes the override. Unscoped ports retain
their whole-installation behavior for homogeneous eligible families; a mixed
selection requires `--family`.

| Configuration                                                    | Runtime support                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| All SQLite, including no database config                         | Supported default; existing lifecycle behavior is unchanged.                    |
| PostgreSQL default for every configurable family                 | Supported runtime, including agents; safety stores stay local SQLite by design. |
| PostgreSQL state with SQLite agents/plugins                      | Runtime, scoped ports, matched backup/restore, and compatible updates.          |
| SQLite state with PostgreSQL Workboard, Logbook, or Team Reports | Runtime, scoped ports, matched backup/restore, and compatible updates.          |
| PostgreSQL state and agents with either engine for plugins       | Runtime, matched backup/restore, and compatible updates.                        |
| SQLite state with PostgreSQL agents                              | Runtime, scoped ports, matched backup/restore, and compatible updates.          |

Back up a mixed installation with `openclaw backup create --verify`; any
PostgreSQL store requires the Gateway stopped through its service owner.
`openclaw backup restore <archive> --target <directory>` extracts the archived
config, SQLite images, and format-2 PostgreSQL envelopes into staging, imports
all producer-declared PostgreSQL stores into fresh namespaces, and publishes
matching anchors and the captured family selections after verification. Copied
user exports remain ordinary files. See the [restore procedure](/gateway/postgresql#restore-all-postgresql-stores)
for older-archive limits and recovery prerequisites.

Run `openclaw update` with a compatible candidate. Before mutation, the
installed updater requires the candidate to understand the configured family
overrides and support each selected or retained PostgreSQL family. Advertising
only global PostgreSQL support is insufficient. All-SQLite and homogeneous
PostgreSQL behavior remains unchanged. Doctor reports the default, override, and
effective engine for every family, and identifies selected-versus-observed
mismatches when physical store evidence is available. Regular status reports the
family map when `database` is configured; `status --all` and JSON status also
report the implicit defaults. These configured choices are separate from runtime
admission, and the reports contain no DSNs.
Fixed-local safety stores do not count as an engine mixture. Agent databases do.
Config-only archive backups remain available for recovery.
Older targets that cannot prove they understand an explicit `database.families`
map are refused before mutation. `openclaw update --dry-run` previews the update
flow, but does not stage a package or run candidate admission; it cannot certify
that an unstaged candidate understands family overrides.
Do not change overrides just to bypass a refusal: configuration changes do not
port stored data.

Mixed storage still requires one Gateway per store. It does not add Team
multi-node ownership, routing, or failover. Cross-family operations retain their
existing separate commit receipts, live authority checks, compensation, and
agent → shared lock ordering. Commit uncertainty does not authorize replay or
compensation without a confirmed agent rollback. This adds no distributed
transaction protocol.

Local agents may avoid their own PostgreSQL round trips, but still depend on
shared-state registration, leases, and commit participants. Lower latency is a
hypothesis to measure for your workload, not a promise of a network-free agent
critical path.

## Search on PostgreSQL

The engine search contract supports native PostgreSQL full text, literal trigram
contains, and exact cosine search. Memory body and path retrieval, agent
transcript text search, and standing-intent matching use this contract.
It does not enable PostgreSQL for an unported store.

Owning components can register additional search definitions with
`admitStoreSearch(connection, definition, { extension: name })` on an admitted
worker connection. PostgreSQL installs
the derived objects and records their definitions in one writer transaction.
Reopening the store verifies PostgreSQL's catalog fingerprint, including these
extensions, without recreating the indexes. Changing a registered definition,
including its vector dimension, is refused with `SearchExtensionDefinitionChangedError`;
restore the previous definition until the owning component provides a derived-index
rebuild. Canonical embeddings remain unchanged. SQLite registration only binds
the existing capability and leaves its FTS5 and vec0 lifecycle unchanged.

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

| Search mode                                                     | PostgreSQL implementation                                           | Required extensions                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Memory body keywords, transcript text, standing-intent keywords | Full text with literal terms, phrases, and supported prefix queries | `unaccent`                                                                  |
| Memory trigram tokenizer                                        | Literal contains matching with native similarity ranking            | `unaccent`, `pg_trgm`                                                       |
| Memory semantic or hybrid retrieval                             | Exact cosine over the admitted embedding model and eligible sources | `unaccent`, `vector`; also `pg_trgm` when the trigram tokenizer is selected |

Missing `pg_trgm` refuses a declared trigram index; it does not silently change
the tokenizer. Missing `unaccent` refuses full-text admission. In either case,
run the extension SQL reported by the error in the selected database and reopen
the store.

The existing explicit keyword-only memory setting is `memory.search.provider: "none"`
(or the corresponding agent-specific override). The engine's keyword-only schema
requires no pgvector extension and exposes no vector capability. Memory status
reports `provider: "none"` and `searchMode: "fts-only"`. Disabling only the native
vector index is not a PostgreSQL JavaScript-scan fallback. An embedding-provider failure
does not silently authorize keyword-only PostgreSQL admission.

Memory admits its search definitions through the agent
database owner, including on the first turn after a port that omits rebuildable
memory indexes. No manual memory-index rebuild is required before chatting.
PostgreSQL rebuilds use connection-local temporary staging and
publish canonical rows and their derived search projections in one writer
transaction. SQLite retains its existing shadow-file publication. Memory search
uses these same admitted projections. Forgetting removes derived text and vector
data in the source-row transaction; reset clears only derived memory data and
retains the admitted search schema. Status uses admitted index facts without
per-request schema probes. PostgreSQL storage diagnostics report memory relation
sizes; WAL and reusable-file bytes are zero because those are server-owned,
not local SQLite files.

The public memory search path uses the admitted PostgreSQL projections. Vector
queries filter model aliases, sources, and any candidate IDs before exact cosine
ordering and the result limit. Keyword queries
use native full-text ranking, or literal contains predicates for the configured
trigram tokenizer. Only bounded result payloads cross into JavaScript. Hybrid
merging keeps the existing default weights of 0.7 vector and 0.3 text; PostgreSQL
text scores remain engine-local and are not calibrated to SQLite BM25. A
keyword-only store needs no vector extension; requesting semantic search without
an admitted vector capability raises `DATABASE_SEARCH_CAPABILITY_UNAVAILABLE`.
The error names the missing extension and the installation SQL. Install it in
the selected database, then reopen the store; use `provider: "none"` when only
keyword search is wanted.

Full text uses a named `simple` plus `unaccent` configuration, a stored generated
`tsvector`, and GIN. Queries bind literal terms and compile conjunctions,
disjunctions, adjacent phrases, and final-lexeme prefixes. User text is never
interpreted as PostgreSQL query operators. Ranking uses `ts_rank_cd` with
normalization 2: scores are engine-local, higher is better, and ordering differs
from SQLite BM25. Tokenization also differs for punctuation, compound words, and
Unicode. Snippets use `ts_headline` only after a materialized, bounded candidate
selection, with a word budget of 2–48, a character cap of 500, and empty highlight markers. Trigram
contains uses its own GIN index and escaped literal `ILIKE`; it is not a universal
fallback for full-text queries. Trigram matches rank by native `word_similarity`
before the result limit; multi-term memory queries average their term scores.

Semantic search uses exact float32 `vector(n)` cosine distance, with model and
source eligibility in the same query before ordering and limit. The canonical
embedding remains its original little-endian binary64 BLOB; source-transaction
triggers maintain the derived float32 projection. Exact vectors support up to
16,000 dimensions. A dimension change requires a matching schema and a derived
index rebuild. There is no ANN, HNSW, IVFFlat, half-precision storage, or transfer
of the PostgreSQL corpus into JavaScript for per-query scoring.

Search sees committed index inserts, updates, and deletes immediately. Memory
files must first pass through normal indexing; changing a file alone does not
write its search projection. Rebuilding derives the same eligible result set
from the canonical rows. Transcript search applies session, agent, role, and
active-branch scope before its result limit; memory search applies its selected
agent and source scope before ranking candidates, plus model scope for vectors.
Memory transcript recall retains the cross-engine 200-candidate window followed
by session visibility checks; this is separate from transcript search's SQL filters.

PostgreSQL memory queries accept at most 4,096 UTF-16 code units and 128 terms, return
at most 200 hits, and bound snippets to 700 characters. Larger queries fail before
retrieval with a message naming the limit.

Transcript queries must contain text and cannot exceed 4,096 UTF-16 code units.
Each search returns at most 25 transcript hits, with excerpts bounded to 500
characters. Literal operator characters are treated as input text rather than
SQL or PostgreSQL query syntax. Prefix matching is an explicit transcript search
mode, not an interpretation of a trailing operator in user text.

Standing-intent matching preserves its channel, sender, agent, expiry, and firing
limits. It examines at most 256 eligible keyword candidates and injects at most
three matching intents within a 1,200-character context budget. Long prompts
use bound literal terms without expanding the SQL expression tree.

Generated columns, GIN indexes, vector projection tables, trigger functions, and
the named text-search mappings participate in the store's exact schema-drift
fingerprint. Rebuilds run under the owning writer transaction. Product-flow
conformance covers memory indexing/search/forget/reset, transcript lifecycle,
standing intents, missing extensions and mixed state/agent engines. PostgreSQL
ranking is intentionally engine-local. Memory transcript visibility retains the
same 200-candidate ACL postfilter as SQLite; complete recall beyond that window
is not guaranteed.

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
engine selection unchanged until the command switches it.

```bash
openclaw database port --to postgres --dry-run
openclaw database port --to postgres
```

Port, backup, restore, and fingerprint operations share one database-family
provider registry. Each provider resolves its stores and supplies the generated
schema descriptor and expected PostgreSQL catalog. **Shared state, agents,
Workboard, Logbook, and Team Reports are registered families.** Matrix account
roots are state-family resources and follow the effective state-family engine.
An unrecognized PostgreSQL anchor
refuses the operation and names the supported families.
For separately installed plugins such as Team Reports, operations load the
selected installed plugin's schema and admission API. Keep the matching plugin
installed for port, backup, and restore. Preflight does not require absent
optional plugins.

The command inventories existing shared state, agents, Workboard, Logbook, and
Team Reports stores, including disabled plugin stores. `--family` limits the
operation to that family's stores; known unrelated stores remain intact.
A real SQLite-to-PostgreSQL port initializes
missing shared state before capture so the config writer uses the same selected
store after the switch when shared state is in scope. It does not create missing
plugin stores. A dry run checks read-only
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
mutually exclusive and cannot be combined with `--family`, `--to`, or `--dry-run`. Completed,
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
use `REPEATABLE READ READ ONLY`. OpenClaw uses the server's `synchronous_commit`
setting. PostgreSQL's default `on` makes acknowledged commits durable across
PostgreSQL or operating-system crashes. For SQLite WAL `synchronous=NORMAL`-like
throughput, operators can opt in with
`ALTER ROLE <openclaw_role> SET synchronous_commit = off` or the equivalent
`ALTER DATABASE` setting. This can lose recently acknowledged commits on a server
or operating-system crash, without corruption. Ports and backups always commit
durably. The adapter sets generous
lock and statement timeouts once during connection setup; operations do not
change timeout settings individually.

PostgreSQL model-context navigation reads parse each selected transcript row once
and keep intermediate projections as JSONB until the navigation and byte counts
cross the database boundary. The read remains bounded by the context page, and
PostgreSQL transcript writes do not precompute navigation envelopes.

## Anchors and backups

A PostgreSQL store keeps a small SQLite anchor at its usual local database path.
The anchor records the store UUID, engine, and PostgreSQL schema. New schemas use
`<schemaPrefix>_<store>_<uuid-prefix>`; moving the anchor preserves the identity.
PostgreSQL schema metadata must match the anchor's store UUID and expected schema
version. Admission checks run once per physical store per process load, and
workers and handles reuse the admitted facts. Confirmed commits and uncertain
commit outcomes invalidate cached store facts through the anchor's write token.

When an agent worker is refused before opening its native writer, the host releases
its prepared lease after native exit. The original refusal reaches its caller,
and other logical borrowers can retry. This explicit refusal also preserves
SQLite's clean-restart seal because no native writer opened. Unknown outcomes
still invalidate that proof, and native and cleanup failures retain their
existing retirement rules.

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

Gateway runtime PostgreSQL queries run in workers. Physical open and boot migration code
may use the synchronous `withEngineStoreAdmission` scope from
`openclaw/plugin-sdk/database-engine-worker-runtime`; retaining a connection after
that scope ends does not authorize main-thread queries. The callback must remain
synchronous. CLI processes classified as one-shots may use the synchronous bridge
for offline commands and Doctor repairs; an unset process role still refuses
main-thread access. One-shot CLI dispatch selects the engine after profile, dotenv,
and config-directed path routing, before commands read shared state. Help, version,
log retrieval, package authoring, and database-only connection repairs remain usable
without database credentials. Gateway processes retain their final-target admission
owner. Interactive onboarding selects storage before its state work and starts
any temporary or foreground Gateway in a separate process; neither process
changes roles during setup.
Updater admission and recovery commands retain their context, receipt, or explicit
path selection. QA fixtures, database tooling, and agent execution likewise keep
their existing target owners.

Gateway RPC commands defer local engine selection until paired-device authentication
needs state. Loopback calls with shared credentials do not require database credentials.
Runtime-intent service status and Gateway discovery also run without a database.
Config validation reports source parse and include errors before selecting storage;
valid config validation and config mutation previews still select the engine before
reading installed-plugin metadata. A channel status config fallback follows the same
metadata requirement.

When Doctor cannot parse config, it attempts the requested file-only config repair
before selecting an engine. If the target remains unresolved, Doctor completes a
best-effort report with database checks marked **unknown**, a config repair next
step, and no database access. It never creates fallback SQLite state. Recovery
that requires database metadata, including verification of a last-known-good
promotion, remains deferred until the target is resolved.

Close remains available to settle resources. The store owner supplies
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

Matched agent backups retain PostgreSQL sequence high-watermarks, including retired
outbox rows. A reverse port uses SQLite's native allocator: plain `INTEGER PRIMARY
KEY` columns allocate after the largest retained row, while `AUTOINCREMENT` columns
retain their recorded high-watermark. Retained outbox order is preserved in both
directions.

Preserve the complete matched set: an anchor alone contains
no PostgreSQL rows. Existing format-1 SQLite backups remain readable.

Matched PostgreSQL snapshot/Git provider restore verifies the matched set, loads
a fresh owned namespace, and publishes its matching anchor only after
verification. Whole-archive restore also imports producer-declared PostgreSQL
capsules into fresh namespaces and publishes the recovered configuration last.
Unlisted copied exports remain ordinary files; older archives can require a new
capture for complete plugin-store recovery. Keep the displaced namespace until
recovery is confirmed. User backups follow the usual
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

Recovery generations include the live PostgreSQL catalog, exact rows, and sequence
allocation state (`last_value` and `is_called`). The installed driver can fingerprint
a candidate's newer schema without loading that schema's descriptor. Restore uses
the captured version's descriptor and retains exact allocation state, including a
sequence deliberately reset below retained row IDs. Maintenance checks the stable
Gateway lease contract independently of the newer application schema.

Update-run admission reads PostgreSQL through its existing schema connection and
initializes only the update-history fragment; it does not copy the anchor as SQLite
state or run candidate schema migrations before managed shutdown.

Candidate Doctor state and agent schema migrations publish their before/after generations through
the existing maintenance write receipt. PostgreSQL table and sequence locks retain
native exclusion until the migration transaction commits; only that confirmed
publication advances the expected generation. Independent writes before migration
or after publication still prevent automatic rollback. Uncertain commit or custody
outcomes keep the captures for recovery. SQLite update behavior and the update
admission protocol are unchanged.

Release packages declare supported engines in the optional
`openclaw.databaseEngines` array in `package.json`, next to
`openclaw.updateAdmissionProtocol`. An absent array means `["sqlite"]`; the
admission protocol remains `1`. PostgreSQL targets also declare
`openclaw.postgresFamilies`: the supported family IDs (`state`, `agent`,
`workboard`, `logbook`, and `team-reports`). On installations configured for PostgreSQL,
the updater checks every selected family and retained physical store, including
disabled plugins. Missing engine or family support refuses before stopping the
previous Gateway or mutating data.
Reverse-port to SQLite with the current compatible binary, or stay on the
current version. Homogeneous PostgreSQL installations include agent stores in
preflight, exact capture, and custody-backed rollback, including retained registry
paths. Family overrides also require successful candidate admission of the
complete selection; global PostgreSQL support alone does not prove this.

Shared-state preflight reads registry, plugin installation, schema-version and
retained-agent facts using the effective state engine. PostgreSQL inspection uses
an admitted read-only transaction in a worker; agent inspection follows each
agent store's physical engine. It never treats the SQLite anchor as application rows or migrates the
source during inspection. Disposable candidate rehearsals use provider-exported
SQLite images and a private SQLite config, so they never reconnect to the source
PostgreSQL namespaces. Exact rollback restores the captured rows while
preserving the current update-run history, as SQLite rollback does.
SQLite-only installations keep their existing admission and inspection behavior.
The installed driver owns these checks; a candidate cannot repair an older
driver. Published 2026.10.5 SQLite → current → PostgreSQL 17 port is qualified,
including foreground Gateway operation, Doctor/status, agent/session/memory
continuity and recovery to the matching stable SQLite backup. The stable package
does not support PostgreSQL, so stable PostgreSQL → current is not applicable.
Live turns were skipped without provider keys; service activation belongs to the
separate signed-Mac/Parallels proof. See the
[qualification cells and run IDs](/gateway/postgresql#published-stable-upgrade-qualification).
See [Update admission](/cli/update#candidate-owned-admission).

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

PostgreSQL read snapshots use read-only repeatable-read transactions. Transactions
that may write acquire the store's advisory lock before reading. Committed typed
writes invalidate only their declared replica scopes; raw writes and schema
changes invalidate the whole store. Empty commits leave replica revisions
unchanged, so unrelated reads can reuse their cached snapshots.
A PostgreSQL function that writes rows and is called through SELECT must be classified unscoped.

Worker commit receipts carry only explicitly staged domain facts on both engines.
A write without staged facts still commits and invalidates caches, but publishes
no domain receipt. Native operation settlement is independent of those facts.

Full transcript hydration reads PostgreSQL payloads in byte-budgeted pages within
one read snapshot. Paging preserves all selected events and their sequence order;
it does not impose a history cutoff. Individual oversized events retain bounded
byte slicing.

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
