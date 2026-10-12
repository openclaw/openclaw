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

## Configure PostgreSQL

Use a PostgreSQL database dedicated to OpenClaw and a role that can create schemas
and tables. Put its connection DSN in a secret, then configure a SecretRef:

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

Workboard is currently the only PostgreSQL-supported store. Shared state,
agent/session storage, and other stores continue using SQLite. Incognito storage
remains memory-only. A supported store never silently falls back to SQLite when
its PostgreSQL connection or admission fails.

Existing SQLite workboard data cannot switch engines yet. Keep that installation
on SQLite until the future `openclaw database port` tool is available; selecting
PostgreSQL refuses the existing store instead of copying, replacing, or ignoring
its data. Omitting `database` preserves the SQLite default, so ordinary updates
require no configuration or data migration.

## Isolation and durability

One Gateway owns each store. PostgreSQL does not enable multiple active Gateways,
external writers, replication management, or connection-pool management.

Writers use `READ COMMITTED` and a transaction-scoped advisory lock derived from
the store identity. Snapshot reads use `REPEATABLE READ READ ONLY`. Connections
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

PostgreSQL catalog admission captures columns, keys, checks, and indexes from the
server in one consistent read. These facts are separate from the anchor's SQLite
catalog. Ordinary data commits retain schema admission; schema owners publish
replacement facts after committed DDL. Optional SQLite WAL, checkpoint, and
page-reclamation work does not apply to PostgreSQL. Explicit SQLite integrity,
repair, and file-snapshot requests refuse with a PostgreSQL recovery instruction.

Runtime PostgreSQL queries run in workers. Physical open and boot migration code
may use the synchronous `withEngineStoreAdmission` scope from
`openclaw/plugin-sdk/database-engine-worker-runtime`; retaining a connection after
that scope ends does not authorize main-thread queries. Close remains available
to settle resources. The store owner supplies `openEngineStore` with its existing
SQLite-data decision, so partially initialized stores are also protected from an
accidental engine switch.

Back up both the local anchor and its PostgreSQL schema as a matched set. Stop
the Gateway while taking or restoring that pair, and include the SQLite stores
that still hold the rest of the installation. A local anchor backup alone does
not contain PostgreSQL rows. See [Backups](/install/backups) for SQLite snapshot
requirements; PostgreSQL backup and restore remain operator-managed.

## Limits and recovery

Fresh stores bootstrap from generated PostgreSQL DDL at the current store schema
version. PostgreSQL forward migrations are not available until schema lockstep
tooling lands. A version mismatch refuses admission; restore a matching backup
with its matching OpenClaw version, or keep the existing version until a supported
migration exists. Never edit the schema version to bypass admission.

PostgreSQL text cannot contain NUL characters. Values containing NUL fail with an
engine error. Search/vector capabilities remain store-specific; selecting an
engine does not add PostgreSQL support to an unported store.

| Failure                                 | Next step                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Missing or unresolved connection secret | Configure `database.postgres.connection` and verify the SecretRef provider is available to the Gateway. |
| Unreachable PostgreSQL server           | Check the DSN, network access, role permissions, and server availability.                               |
| Store UUID mismatch                     | Restore the matching anchor and PostgreSQL schema; do not pair an anchor with another store.            |
| Newer or otherwise mismatched schema    | Use the matching OpenClaw version or restore its matching backup; do not force a downgrade.             |

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
