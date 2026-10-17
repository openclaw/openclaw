---
summary: "Set up and operate an experimental PostgreSQL-backed Gateway, including ports, backups, and recovery limits"
read_when:
  - Setting up PostgreSQL for an OpenClaw Gateway
  - Migrating an existing installation between SQLite and PostgreSQL
  - Planning PostgreSQL backups, updates, or disaster recovery
title: "PostgreSQL operator guide"
doc-schema-version: 1
---

# PostgreSQL operator guide

Use this guide to provision PostgreSQL for one Gateway, move existing data, and
operate the resulting installation. PostgreSQL is **experimental**. SQLite
remains the default. See the [store support matrix](/reference/database-engines#configure-postgresql)
for coverage; selecting PostgreSQL does not move every local file into the server.

<Warning>
  PostgreSQL and mixed-engine operation remain experimental. Native credential
  and execution-approval work is not fully cut over. Full-archive extraction also
  does not recreate PostgreSQL namespaces;
  read [Backup and restore](#backup-and-restore) before relying on it for recovery.
</Warning>

## When to use PostgreSQL

Choose PostgreSQL when you want supported Gateway stores on an independently
managed database server and can operate its availability, access control, and
backups. Keep SQLite when you want the default local installation without that
server dependency. PostgreSQL does not add multiple active Gateways for one
installation, automatic failover, or automatic replication management.

Keep the local state directory and configured agent directories. Each PostgreSQL
store still has a small SQLite **anchor** at its usual database path. It records
the store UUID and server namespace, not the server's application rows. An anchor
and its matching PostgreSQL data are one recovery unit. Never delete an anchor to
change engines.

The quarantine, managed-update, and package-activation safety journals remain
local SQLite. Daemon runtime pins remain in `control/services.sqlite` so service
recovery does not require PostgreSQL. Device-local caches and file artifacts
remain local; this includes Logbook frame images and cold transcript blobs.
Incognito storage remains memory-only. The `memory-lancedb` plugin uses its own
LanceDB store and is not switched by `database.engine`.

The prepared `client/credentials.sqlite` format is also fixed local, but current
production credential consumers have not all moved to it. Do not infer that
every device/native credential or execution-approval path is independent of
shared state yet. See the [native credential contract](/reference/database-schemas/versioning#local-credential-store-preparation).

When present, the local credential store is captured as a fixed-local resource,
outside the engine families. User backups apply its credential sanitization;
updater recovery captures it exactly.

## Requirements

### Provision a database and runtime role

Use PostgreSQL **16 or newer**, with **UTF8 server and client encoding**. Provision
a separate database per Gateway. The runtime role must be able to connect,
create schemas, and own the objects it creates. It does not need superuser,
role-administration, or database-creation privileges.

For a fresh database, an administrator can run the following, then set the
runtime role's password using the administrator's credential-management tooling:

```sql
CREATE ROLE openclaw_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE openclaw ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE openclaw FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE openclaw TO openclaw_runtime;
```

In the new `openclaw` database, install the search extensions as an administrator:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
GRANT USAGE ON SCHEMA public TO openclaw_runtime;
```

For semantic or hybrid memory search, also install pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
```

`unaccent` is required for full-text search; `pg_trgm` is required when a store
declares trigram search. Installing both covers either text mode. The extension
SQL never runs automatically. Install any missing server extension packages
before running it. Managed services must expose the extensions in the actual
database you select.

`CREATE` on the database is needed beyond the first store: schema verification
can create and drop a private comparison namespace during bootstrap, migrations,
and server-major upgrades. `TEMPORARY` supports memory rebuild staging and
session-local plugin scratch tables. The runtime role owns its store schemas,
tables, sequences, indexes, functions, and text-search configurations; keep that
ownership when restoring or changing roles. Port and restore check namespace
ownership, so table grants alone are insufficient.

The grants above assume PostgreSQL's default public execution privileges for
extension functions and usage privileges for extension types. If your
administrator has revoked those defaults, also grant the runtime role access to
the required extension functions and types. Do not grant the runtime role
permission to install extensions or access other installations' schemas merely
to make admission pass.

### Supply the connection securely

Store the DSN in your secret manager and make it available to both the Gateway
service and offline maintenance commands. Reference it from config; do not put
the DSN itself in `openclaw.json`:

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

Env, file, and exec [SecretRefs](/gateway/secrets/secretref-contract) are supported.
A store-backed SecretRef cannot bootstrap the database that holds that secret.
The host resolves the connection before passing it to workers. Restart after
changing the connection, prefix, or engine map; these are fixed for the process.
An all-SQLite configuration does not resolve an unused PostgreSQL connection.

TLS options are DSN query parameters handled by the PostgreSQL driver, not
additional `database.postgres` config keys. For example, the **secret value**
could have this shape (the password is a placeholder):

```text
postgresql://openclaw_runtime:<URL_ENCODED_PASSWORD>@db.example.com:5432/openclaw?sslmode=verify-full&sslrootcert=/etc/openclaw/postgres-ca.pem
```

Use `sslmode=verify-full` for certificate and hostname verification. Omit
`sslrootcert` when the server uses a certificate trusted by the runtime's normal
CA configuration. `sslcert` and `sslkey` can supply client-certificate file paths
when required by the server. Those files must be readable on the Gateway and
maintenance host. URL-encode special characters in credentials and paths.
`sslmode=disable` disables TLS; reserve it for a deliberately local connection.
Keep DSNs out of shell history, diagnostic captures, and logs.

## Set up a fresh installation

1. Provision the database, role, extensions, and connection secret above.
2. Add the PostgreSQL config before the installation creates its first stores.
   Configure other Gateway settings through the normal [setup flow](/start/getting-started).
   If it has already created SQLite stores, follow [migration](#migrate-an-existing-installation)
   instead of changing the engine setting directly.
3. Start the Gateway through its normal service owner. First open creates each
   store's local anchor, a UUID-qualified PostgreSQL schema, and the current
   generated schema. Stores are created as their owners open them; an unused
   plugin need not have a namespace yet.
4. Verify from the same configured installation:

   ```bash
   openclaw doctor
   openclaw status
   openclaw health
   ```

Doctor's `Database engines` section should include:

```text
Shared state: default=postgres, override=inherit, effective=postgres (configured)
Agent data: default=postgres, override=inherit, effective=postgres (configured)
```

The `(configured)` suffix matters: these lines describe selection, not a
successful open of every store. Doctor also reports physical shared-state roots
and namespaces, and warns that PostgreSQL is experimental. Verify Gateway
health and exercise the agent/plugin features you enabled. A failed PostgreSQL
connection or schema admission never silently switches that store to SQLite.

## Run independent Gateways on one server

Use a separate PostgreSQL database, runtime role, connection secret, and local
state directory for each Gateway. Each database may use the default
`schemaPrefix: "openclaw"`. Install extensions in each database.

Alternatively, independent installations can share a database with distinct
prefixes such as `installation_a` and `installation_b`. Prefixes contain 1–27
lowercase letters, digits, or underscores, beginning with a letter or underscore.
New schemas have the shape `<prefix>_<store>_<uuid-prefix>`. Existing anchors keep
their recorded namespace when the configured prefix changes.

A prefix is a naming convention, not an access-control boundary. Use separate
roles and appropriate schema permissions if sharing a database. Extensions in
`public` are shared; store objects remain in their own namespaces. Keep each
anchor with its originating installation.

There is still **one Gateway per store**. Do not mount the same state directory
on multiple Gateways or copy its anchors to make an HA/failover installation.
Advisory writer locks protect transactions; they do not provide multi-Gateway
ownership, routing, or failover.

## Mixed engines (experimental)

`database.families` can override `state`, `agent`, `workboard`, `logbook`, and
`team-reports`. Every override requires an `engine`. All PostgreSQL families
share one connection and prefix. Fixed-local journals cannot be overridden.

For fresh stores, this selects PostgreSQL shared state while retaining SQLite
agents and plugin stores:

```json5
{
  database: {
    engine: "sqlite",
    families: { state: { engine: "postgres" } },
    postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
    },
  },
}
```

Both SQLite and PostgreSQL agents are supported with either shared-state engine.
Workboard, Logbook, and Team Reports can independently select either engine.
Matrix account and token-hash roots belong to the state family and follow its
effective engine, including retained and disabled accounts.

Use a scoped port to change an existing family:

```bash
openclaw database port --family workboard --to postgres --dry-run
openclaw database port --family workboard --to postgres
openclaw database port --family agent --to postgres
openclaw database port --family workboard --to sqlite
```

Each operation ports every existing physical store of that family and publishes
only its override. The default and unrelated families remain unchanged. A
destination equal to the default removes the redundant override. Unscoped ports
retain whole-installation behavior for homogeneous eligible families; mixed
selections require `--family`.

Mixed installations support matched backup/restore and compatible updates.
Whole-installation backups containing any PostgreSQL store require offline
custody. Archive extraction still does not recreate PostgreSQL namespaces.
Updates require candidate proof of family-override support as well as support
for each selected or retained PostgreSQL family.

Do not change a populated family's engine to evade a refusal. Configuration does
not migrate data.

## Migrate an existing installation

### Prepare and port to PostgreSQL

While the installation still selects SQLite, run:

```bash
openclaw doctor --fix
```

This is the legacy migration gate. Port preflight refuses pending declared
migrations, including native task assignments, Matrix inbound dedupe, and legacy
memory-index sidecars. Upgrade older shared state with a compatible binary and
Doctor before retrying. Agent schema upgrades can run in the port's private copy.
A scoped port checks only migrations declared for that family. Fresh Matrix
roots without legacy inbound-dedupe rows do not require a completion receipt.

Provision PostgreSQL and add `database.postgres.connection`, but leave the source
engine selections unchanged. Stop the Gateway through its service owner and stop
embedded writers using the same state directory. Port never stops or restarts
services for you.

```bash
openclaw database port --to postgres --dry-run
openclaw database port --to postgres
```

The dry run inventories sources and checks read-only prerequisites. It does not
create a recovery manifest, copy data, create destination namespaces, or complete
checks that need private migration or a privilege probe. `--json` is available.

The real port includes registered shared-state, agent, Workboard, Logbook, and
Team Reports stores, including retained roots and disabled plugin data. Keep
matching separately installed plugins available so their schema owners can be
loaded. Source files and config, including includes, are captured under
`<stateDir>/recovery/database-port/<operation-id>/` before publication. Destination
stores are privately migrated and verified; config switches last and preserves
SecretRefs. Retain the captures until recovery is confirmed.

Cold transcript references and file-artifact paths remain in place. Rebuildable
memory indexes are omitted from the agent port; canonical memory origins and
tombstones are retained. Their automatic rebuild hook is still pending. While
the Gateway is still stopped, rebuild and check Memory Core before relying on
recall:

```bash
openclaw memory index
openclaw memory status
```

These commands require offline ownership. See the [memory CLI](/cli/memory)
for per-agent selection and other memory plugins. Then start the Gateway through
its service owner and run Doctor, status, and health.

### Recover an interrupted port

An incomplete operation blocks startup using the active manifest at
`<stateDir>/recovery/database-port/manifest.json`. Keep the Gateway stopped and
choose one action:

```bash
openclaw database port --resume <stateDir>/recovery/database-port/manifest.json
openclaw database port --rollback <stateDir>/recovery/database-port/manifest.json
```

Resume revalidates captured evidence and finishes the operation. Rollback
restores its original stores and config. These options are mutually exclusive
and cannot be combined with `--family`, `--to`, or `--dry-run`. Preserve unreadable
or damaged manifests and their captures for diagnosis. A completed, archived manifest is
not an undo operation after runtime writes have resumed.

### Understand refusals

Port refuses live or unverifiable writer ownership, an ambiguous unscoped mixed
selection, pending legacy migrations for the affected families, unsupported
stores or source schema, schema drift, mismatched anchors, insufficient namespace
ownership/privileges, and changed recovery evidence. PostgreSQL cannot represent
NUL-containing text;
invalid source data can therefore refuse a port. Duplicate-key voice JSON also
refuses rather than silently losing data. Follow the reported repair and retain
the original data; never edit metadata or discard an anchor to force admission.

## Backup and restore

### Capture both server data and local state

Stop the Gateway and embedded writers before capturing PostgreSQL. Then run:

```bash
openclaw backup create --output ~/Backups/openclaw --verify
```

The archive combines local files and SQLite images with each actual PostgreSQL
store's matched **format-2 envelope**: original anchor, portable SQLite export image, and manifest
containing identity, schema versions, active fragments, allocation facts, sizes,
and hashes. The DSN is not in that envelope. The surrounding archive contains
config and may contain other credentials; protect it accordingly. Supply external
SecretRef values separately during recovery.

User backups apply the owning stores' sanitization rules. They are not the
exact unsanitized captures used for updater recovery. SQLite and PostgreSQL Git
exports apply the same `--exclude-secrets` policy, including credential tables,
machine-state keys, and generated model-catalog credentials. Keep Logbook images, cold
transcript blobs, workspaces, config includes, and local state with the database
backup. Neither a server dump alone nor a copied anchor covers the installation.

### Current restore limits

`openclaw backup restore <archive> --target <directory>` verifies and extracts
into a fresh staging directory. It **does not import PostgreSQL rows or recreate
namespaces**. Moving the extracted anchor into place cannot recover a lost server.
`openclaw backup sqlite restore` is SQLite-only.

The engine supports verified restore into a fresh owned PostgreSQL namespace,
with anchor publication after verification. Current Git backup CLI exposes this
for **shared state and individually selected agents**. It has no plugin-store
restore selector. Complete archive-to-PostgreSQL rehydration and plugin-store CLI
restore remain gaps; do not treat full-archive verification as proof of complete
disaster recovery. Keep a tested PostgreSQL-native recovery procedure for stores
outside the CLI restore scopes, preserving their matching local anchors.

### Disaster recovery for shared state and agents

Prepare explicit Git recovery points while offline, alongside the full archive:

```bash
openclaw backup git init --repository ~/Backups/openclaw-git
openclaw backup git create --repository ~/Backups/openclaw-git --global --agent main
openclaw backup git log --repository ~/Backups/openclaw-git
```

Repeat `--agent` for each configured agent. Use explicit scopes: the current
`--all` PostgreSQL discovery path does not distinguish every additional plugin
or retained root reliably. Record the resulting commit and keep the repository
private. Git database backups do not replace file/config backups.

`openclaw backup git verify` currently exercises restore for PostgreSQL: it needs
the configured database and offline custody, and creates a new server namespace.
It is not a files-only verification command. `openclaw backup verify <archive>`
checks archive structure and layout without proving PostgreSQL rehydration.

To recover these scopes:

1. Keep all writers stopped. Provision a compatible PostgreSQL server, a fresh
   database, runtime role, and required extensions as above.
2. Stage the backed-up config and files using the [archive restore workflow](/install/backups#restore-a-full-archive).
   Set the recovery installation's state/config paths and agent directories;
   supply its external connection secret separately, pointing at the recovery
   database. Preserve the matching `database.engine` and `database.families`
   selections, and use a compatible OpenClaw version and matching plugins.
3. Restore each Git scope from the **same recorded commit** to a nonexistent
   local target, outside the backup repository:

   ```bash
   openclaw backup git restore --repository ~/Backups/openclaw-git --ref <commit> --global --target ./recovered/openclaw.sqlite
   openclaw backup git restore --repository ~/Backups/openclaw-git --ref <commit> --agent main --target ./recovered/main/openclaw-agent.sqlite
   ```

   Each PostgreSQL restore loads a fresh namespace using the configured
   connection and publishes a matching local anchor only after verification.
   It does not overwrite an existing target or restore into a live namespace.

4. Put those verified anchors at the recovery installation's corresponding
   shared-state and agent database paths, replacing only staged historical
   anchors while offline. Preserve the old installation and namespaces until
   recovery is confirmed. Recover any other PostgreSQL store through its tested
   server recovery procedure before starting the installation.
5. Run `openclaw doctor`, start through the service owner, then check
   `openclaw health`, `openclaw status`, representative sessions, search, and
   enabled plugins. Review pending approvals and channel relinking needs after
   rollback; a backup restores historical state.

## Updates and schema migrations

Use `openclaw update` for supported update admission. Before stopping the previous
Gateway or changing data, it checks the target's declared engine and PostgreSQL
family support against selected families and retained physical stores. Explicit
family overrides also require successful candidate admission of the complete
selection; global PostgreSQL support alone is insufficient. A target without
that proof is refused. A raw package-manager downgrade does not provide this
guard.

Before mutation, the updater captures exact PostgreSQL rows, sequence allocation
state, schema facts, and matching anchors alongside local SQLite state and config.
Recovery restores into fresh namespaces and publishes matching anchors. It
preserves current update-run history. Independent writes, changed recovery
generations, or uncertain custody/commit outcomes prevent automatic restore and
retain captures for recovery. This is not an unconditional rollback guarantee.
See [update compatibility and recovery](/reference/database-engines#updates-and-target-compatibility).

Store owners run consecutive forward schema migrations under a writer transaction.
Admission verifies the generated destination schema before publication. Missing
migrations, newer schemas, and drift refuse admission; use a compatible binary
or restore a matched backup. Never edit version/fingerprint metadata. Doctor's
state migrations take their own exact backup before mutation.

First boot, ports, rebuilds, and migrations can take longer on slow disks or a
remote server. Connection and lock waits allow 60 seconds; the engine sets a
90-second statement timeout and a 120-second synchronous bridge deadline.
These are not per-operation config options. A timeout is a failure to investigate,
not permission to delete recovery state. Inspect server load, locks, network, and
storage, and retry only after resolving the reported cause.

The runtime sets `synchronous_commit=off`, matching the intended SQLite
`synchronous=NORMAL` tradeoff. A PostgreSQL server or operating-system crash can
lose recently acknowledged commits. Plan backups and recovery objectives with
that durability policy in mind.

## Search on PostgreSQL

Full text uses PostgreSQL's `simple` plus `unaccent` configuration and native
ranking. Trigram mode performs literal contains matching with native similarity
ranking. Semantic retrieval uses exact cosine distance through pgvector; it does
not create an approximate-nearest-neighbor index.

Scores and tokenization are engine-local. Expect different ordering from SQLite
BM25, particularly for punctuation, compound words, and Unicode. Hybrid retrieval
keeps the existing text/vector weighting, not cross-engine score equivalence.
See [search modes and limits](/reference/database-engines#search-on-postgresql).

Without pgvector, explicitly select keyword-only memory before opening its store:

```json5
{
  memory: {
    search: { provider: "none" },
  },
}
```

Memory status then reports `provider: "none"` and `searchMode: "fts-only"`.
Missing pgvector or an embedding-provider failure does not silently choose this
mode. Missing `unaccent` or a required `pg_trgm` refuses admission rather than
returning empty search results. Reopen the store after installing the extension.

## Monitoring and troubleshooting

Use `openclaw doctor` for configured family selections and physical shared-state
root checks. A line such as `physical=postgres, namespace=...` identifies the
anchor's physical selection; a configured line alone does not prove connectivity.
An engine mismatch or `Database roots could not all be inspected.` needs
investigation before restart or migration.

`openclaw status` summarizes Gateway reachability, services, sessions, and memory
readiness. Its Memory row describes the active memory system's vector/FTS/cache
status; it is not an installation-wide PostgreSQL health check. Use
`openclaw health` and actual enabled feature operations alongside Doctor.
Monitor PostgreSQL availability, connections, locks, storage, and backup success
through your database operator's normal monitoring.

The following are exact error strings or exact stable prefixes (variable details
follow a prefix):

| Error text                                                                                                                                             | Next step                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `PostgreSQL requires version 16 or newer and UTF8 server/client encoding; upgrade the server or port to a UTF8 database and set client_encoding=UTF8.` | Upgrade PostgreSQL or select a UTF8 database/client connection.                                                          |
| `PostgreSQL bootstrap cannot use a store-backed SecretRef; use env, file or exec.`                                                                     | Move the connection secret to an external bootstrap source.                                                              |
| `Cannot open PostgreSQL connection:`                                                                                                                   | Check the service's SecretRef environment, DSN/TLS, network, role, and server availability.                              |
| `PostgreSQL search capability unavailable: insufficient CREATE privilege.`                                                                             | Restore database/schema creation privileges and store ownership; see requirements.                                       |
| `DATABASE_SEARCH_CAPABILITY_UNAVAILABLE`                                                                                                               | Follow the named extension installation SQL, or explicitly choose keyword-only memory when only vectors are unavailable. |
| `Missing PostgreSQL anchor; restore the matching PostgreSQL schema and anchor.`                                                                        | Restore the complete matched set. Do not create a replacement anchor manually.                                           |
| `Invalid PostgreSQL anchor identity. Restore a matching backup.`                                                                                       | Restore the original matching anchor and server data.                                                                    |
| `PostgreSQL database identity mismatch:`                                                                                                               | Restore the matching pair; an anchor from another namespace is not interchangeable.                                      |
| `PostgreSQL schema drift detected.`                                                                                                                    | Use the compatible binary or restore matching data; do not edit metadata.                                                |
| `PostgreSQL connection lost; transaction rolled back`                                                                                                  | Restore connectivity and reopen the failed store through its owner before retrying.                                      |
| `PostgreSQL connection lost; outcome unknown`                                                                                                          | Reconcile whether the operation committed before repeating an external effect.                                           |

Connection loss closes the failed connection. The engine distinguishes a known
rolled-back transaction from an uncertain outcome, invalidating cached facts
when a commit may have occurred. It does not switch to SQLite or promise
transparent replay of every operation. Recover server connectivity, inspect the
operation's recorded result, and restart the Gateway through its service owner
if needed to reopen stores.

## Roll back to SQLite

Use the current compatible binary, keep the PostgreSQL secret available, and
stop all writers. Run a **new reverse port**:

```bash
openclaw database port --to sqlite --dry-run
openclaw database port --to sqlite
```

For a mixed installation, port one family at a time instead:

```bash
openclaw database port --family workboard --to sqlite --dry-run
openclaw database port --family workboard --to sqlite
```

The new port carries writes accepted since the earlier migration. Restoring an
old SQLite capture would lose those writes. After success, start the Gateway
and verify Doctor, health, and the affected features. Former PostgreSQL
namespaces are retained, not dropped automatically. Reverse-port before a
downgrade to a build that lacks PostgreSQL support.
