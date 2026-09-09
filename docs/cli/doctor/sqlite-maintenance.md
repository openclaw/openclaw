---
summary: "Shared-state compaction plus targeted session SQLite inspection, import, and recovery"
title: "SQLite maintenance and session migration"
read_when:
  - You are compacting or verifying an OpenClaw SQLite database
  - You are importing, validating, or recovering legacy session history
---

Explicit SQLite maintenance runs offline, with the Gateway stopped. This page covers
shared-state compaction and the targeted session SQLite modes.

## Shared state SQLite compaction

See [Database schemas](/reference/database-schemas) for schema versioning, integrity checks, and downgrade recovery.

`openclaw doctor --state-sqlite compact` is explicit offline maintenance for
the canonical shared state database at
`<state-dir>/state/openclaw.sqlite`. It does not accept an arbitrary database
path, is never invoked by normal Gateway operation, and is not part of
`openclaw doctor --fix`. The command acquires the same state ownership lock as
Gateway startup and holds it through validation, checkpointing, `VACUUM`, and
the final integrity checks. It refuses to run while a Gateway or another
SQLite maintenance command owns that lock. The state lock remains active when
`OPENCLAW_ALLOW_MULTI_GATEWAY=1` skips the per-config Gateway singleton, so an
operator shell does not need to inherit the Gateway service's environment for
maintenance to detect it.

Stop the Gateway and create a verified backup first:

```bash
openclaw gateway stop
openclaw backup create --verify
openclaw doctor --state-sqlite compact --json
openclaw gateway start
```

The command:

1. Requires a regular file at the canonical shared-state path. A missing
   database is reported as `skipped` and exits successfully.
2. Validates the current supported schema version and
   `schema_meta.role = "global"` before checkpointing or changing the file.
3. Requires a non-busy `wal_checkpoint(TRUNCATE)`. Stop any remaining OpenClaw
   process and retry if the checkpoint is busy.
4. Sets `auto_vacuum` to `INCREMENTAL`, runs a full `VACUUM`, and checkpoints
   again.
5. Runs `quick_check`, `integrity_check`, and `foreign_key_check`, then
   reapplies owner-only permissions to the database and SQLite sidecar files.

JSON output reports the database and WAL sizes, freelist pages, page size, and
`auto_vacuum` value before and after compaction, plus reclaimed bytes and the
`quick_check` and `integrity_check` results. `foreign_key_check` is enforced
fail-closed and has no separate success field. SQLite reports `auto_vacuum` as
`0` for none, `1` for full, and `2` for incremental.

Compaction fails without mutation when the schema is old, newer than the
running OpenClaw build, or belongs to an agent database. Run
`openclaw doctor --fix` first for an older shared-state schema. Restore a
compatible backup or upgrade OpenClaw for a newer schema.

## Session SQLite migration

Runtime session rows and transcripts live in SQLite, by default at
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. Gateway and local
CLI startup do not import, restore, or rewrite legacy session JSON/JSONL files.
When startup finds a legacy session store, it refuses readiness and prints a
`doctor --fix` command for the active profile instead of serving empty history.

To upgrade history from an older file-backed installation, stop the Gateway,
back up its state, and run `openclaw doctor --fix` before restarting it.
`openclaw doctor --session-sqlite <mode>` provides targeted inspection,
import, validation, and SQLite maintenance. Legacy `sessions.json` files are
migration sources. Hot transcript JSONL files are imported and archived after
successful import; archive-tier JSONL files remain support artifacts, not
runtime fallbacks.

The public Doctor migration path stages transcript payloads and performs branch
and provider repairs in a private, temporary SQLite database instead of retaining
complete histories in memory. It keeps the raw transcript untouched until archiving it through an
exclusive same-filesystem move, avoiding both an extra full `.pre-doctor` raw
copy and a rewritten intermediate file. Standalone transcript repair retains
its original backup behavior.

For large histories, plan space for the original JSON/JSONL files, the temporary
SQLite spool, and the destination database and WAL at the same time. Keep free
space on both the system temporary volume and the volume holding OpenClaw state;
the resulting SQLite database can be larger than the original JSONL. Streaming
reduces whole-history memory pressure, but individual records are still parsed
in memory and SQLite also uses native memory. Do not size a host from the JSONL
byte count or JavaScript heap limit alone; there is no fixed disk, RAM, or
migration-time guarantee.

Staging is removed when the operation finishes and is never used as a runtime
store or resumed after an interruption; retries use the original sources and
committed session data. After import, Doctor checkpoints and incrementally vacuums databases that already
support auto-vacuum, retaining full integrity and foreign-key checks before and
after cleanup. Databases without auto-vacuum still need a full `VACUUM` to enable
it. Incremental cleanup frees unused pages but does not repack partially filled
pages; explicit session and shared-state `compact` modes still run a full `VACUUM`.

The regular `openclaw doctor` pass also reports canonical SQLite transcripts
whose initial session header was never persisted. `openclaw doctor --fix`
prepends a current header and rebuilds the transcript indexes in one
transaction while preserving existing event IDs, parent links, row timestamps,
and session-list recency. Headerless legacy or malformed transcripts remain
rejected until their owning migration can validate them.

Modes:

| Mode       | Behavior                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inspect`  | Read SQLite counts and any selected legacy-source diagnostics without importing; legacy files are not required.        |
| `dry-run`  | Parse legacy entries and transcript JSONL files, count importable rows, and report issues without writing SQLite rows. |
| `import`   | Import legacy entries and transcript events into SQLite for the selected targets.                                      |
| `validate` | Compare the selected legacy sources against SQLite rows and transcript event counts.                                   |
| `compact`  | Checkpoint and VACUUM selected agent SQLite databases to reclaim free pages after large deletes or archive cleanup.    |
| `recover`  | Restore the latest failed migration run, validate its targets, and prepare a sanitized GitHub issue report.            |
| `restore`  | Restore archived transcript artifacts from recorded migration manifests without deleting SQLite data.                  |

Selectors:

- Default: the configured default agent store; SQLite inspection does not require a legacy file.
- `--session-sqlite-agent <id>`: one configured agent.
- `--session-sqlite-all-agents`: configured agent stores plus discovered agent stores.
- `--session-sqlite-store <path>`: one explicit `.sqlite` database or legacy `sessions.json` path.

`dry-run`, `import`, and `validate` select existing legacy sources only. An
explicit `.sqlite` path selects no legacy targets in those modes; it is never
parsed or archived as JSON. Use `inspect`, `compact`, or corruption recovery
with `recover` for a SQLite target. Recovering or restoring archived sources
from migration manifests requires the original legacy selector or agent-store
discovery that includes it. Legacy `sessions.json` selector paths remain
supported and resolve to their corresponding SQLite stores for maintenance.

With the Gateway stopped and its state backed up, inspect and import legacy
history:

```bash
openclaw doctor --session-sqlite inspect --session-sqlite-all-agents
openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json
openclaw doctor --session-sqlite import --session-sqlite-all-agents
openclaw doctor --session-sqlite inspect --session-sqlite-all-agents --json
```

`import` validates rows and transcript event counts before archiving its
legacy sources. After a successful import, `validate` may select no legacy
targets; use `inspect` to see the current SQLite state. While legacy sources
remain, `validate` exits non-zero when a selected entry is missing from SQLite,
a session id differs, or a transcript event count differs.
When using `--session-sqlite-store <path>`, check that the report contains the
expected target count; a nonexistent legacy source selects no targets for
`dry-run`, `import`, or `validate`.

SQLite deletes reclaim pages inside the database first; they do not necessarily
shrink the database file immediately. After deleting or archiving large
transcripts, run `openclaw doctor --session-sqlite compact --session-sqlite-all-agents`
to checkpoint WAL files, run `VACUUM`, and report before/after database and WAL
sizes. Compaction requires a regular file with the current agent schema, its
durable database owner metadata, and no open handle in the doctor
process. The destructive `import`, `compact`, `recover`, and `restore` modes
hold the same state ownership lock as Gateway startup for their full operation;
`inspect`, `dry-run`, and `validate` remain read-only and do not take it. Stop
the Gateway first. Destructive modes fail instead of racing live writes or
racing another maintenance command. A destructive `--session-sqlite-store`
target must be inside the active state directory; set `OPENCLAW_STATE_DIR` to
the store's owning state directory before maintaining another installation.
Existing hard-linked targets are rejected because another path can share the
same database inode outside the locked state directory. The same ownership
checks cover SQLite WAL, shared-memory, and rollback-journal sidecars.

Each import writes a manifest under
`~/.openclaw/session-sqlite-migration-runs/` before moving transcript artifacts
into the archive. Recovery references stay in the current sessions directory,
including for backups with old-machine absolute transcript paths. Retrying an
interrupted import keeps the index and previously archived transcripts restorable.
If an explicit import fails after artifacts moved, keep the Gateway stopped and
run recovery:

```bash
openclaw doctor --session-sqlite recover --github-issue
```

Recovery selects the latest failed migration manifest, restores only the
manifest's archived artifacts, validates the affected targets, and prepares
sanitized `.failure.md` and `.failure.json` reports. The GitHub issue body avoids
transcript contents, raw environment, secrets, and unbounded config. Once an
issue or browser handoff may have published a report, doctor preserves that
private report artifact and its marker receipt. When no failed migration
manifest exists, recovery inspects selected
SQLite databases using temporary copies of their complete file sets. SQLite
can roll back a valid hot journal in that disposable copy
before `quick_check`, `integrity_check`, and `foreign_key_check` run, while the
original forensic files remain untouched during inspection. Recovery attempts
to repair canonical index corruption in place after schema and owner validation.
Schema, owner, and I/O errors, as well as failed or refused index repairs,
leave the original database in place with a diagnostic. Other confirmed
corruption or orphaned sidecars
preserve the DB, WAL, SHM, and rollback-journal files by renaming the
whole discovered set with one `.corrupt-<timestamp>` suffix. A caught rename
failure rolls already-moved files back before reporting failure, so a
recoverable file set is not silently split. Stop the Gateway before recovery;
copying or renaming an actively changing SQLite file set is unsafe and behaves
differently across operating systems. With `--github-issue --yes`, doctor uses
the GitHub CLI to create the issue in `openclaw/openclaw`. If the CLI is
unavailable or GitHub definitively rejects the request, doctor can open the
exact sanitized report in a browser when its encoded URL stays within the safe
request-size bound. Without confirmation, doctor writes the local support
report and skips issue creation without printing or opening a prefilled URL.
Ambiguous submissions fail closed. A later doctor run reconciles the preserved
marker without sending another create request, so it cannot publish a duplicate
issue. Machine-readable output includes the resulting support-issue status but
not the private receipt or prefilled URL.

`restore` remains the lower-level undo operation. It uses manifest
`sourcePath -> archivePath` records, moves archived artifacts back only when the
original path is missing, reports conflicts for independently existing originals,
and leaves the SQLite database in place. Publication is exclusive: a file or
symbolic link created during verification is not replaced. Restore moves the
original without copying its contents, and fails without consuming the archive
if the filesystem cannot publish it safely. Recorded interrupted publications
can be retried, including with older manifests or after the replacement SQLite
database has been removed. If restore recreates a missing sessions directory,
retries repeat its parent-directory durability check before consuming the archive.
When several manifests recorded the same original path, restore plans all
candidates before moving any of them. Identical archives
are safe duplicates, and one nonempty legacy `sessions.json` may supersede empty
copies created by older writers. Distinct nonempty indexes, distinct transcript
archives, invalid archives, and archives missing without a recorded prior
restore fail closed so restore cannot silently replace or hide recoverable data.

After verifying the migration and current history, use
`openclaw update cleanup --dry-run` to inspect retained recovery data without
stopping the Gateway. Apply with `openclaw update cleanup` or
`openclaw update cleanup --yes --json` only after stopping the Gateway, other
SQLite maintenance, and database readers for the same profile/state directory.
Keep session-listing watchers stopped until cleanup exits: even read-only
connections can change WAL/SHM sidecars and invalidate verification. This permanently
retires eligible rollback originals; it does not remove current SQLite history
or operator backups. Manifests remain while retained or pending artifacts need
them, so interrupted cleanup can be resumed. Restore distinguishes intentional
disposal, pending cleanup, and unexpected missing files. See
[Update cleanup](/cli/update#update-cleanup).

### Downgrading After Session SQLite Migration

Follow [Downgrade](/install/updating#downgrade) before starting an older release.
With writers stopped, `openclaw doctor --session-sqlite restore
--session-sqlite-all-agents` restores manifest-recorded legacy transcript
artifacts to their original paths. This supports recovery from retained originals;
it does not reverse SQLite schema migrations or replace a pre-update backup.

Run recovery before `openclaw update cleanup` retires those originals. After
cleanup, restore reports intentional disposal and cannot recreate them. Sessions
created only in SQLite will not appear to an older file-backed runtime. If you
upgrade again, use the normal migration validation sequence above to compare
restored artifacts with SQLite rows before importing.
