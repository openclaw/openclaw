---
summary: "Shared-state compaction plus targeted session SQLite inspection, import, and recovery"
title: "SQLite maintenance and session migration"
read_when:
  - You are compacting or verifying an OpenClaw SQLite database
  - You are importing, validating, or recovering legacy session history
---

Explicit SQLite maintenance runs offline, with the Gateway stopped. This page covers
shared-state compaction and the targeted session SQLite modes.

On Linux, a stopped Gateway service can still have child processes in its systemd
cgroup. Doctor and update maintenance remain blocked until those processes exit.
Inspect the service status and journal, and have the process owner stop the
remaining children before retrying. A root-owned child may require administrator
help even when the Gateway itself runs as a user service.

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
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. Gateway startup uses
Doctor's exclusive maintenance owner to migrate legacy session JSON/JSONL files
before checking readiness. Runtime reads use only canonical SQLite state.
An unreadable legacy session index stays at its original path with its transcripts,
so repeated startups refuse readiness and print the active profile's
`doctor --fix` command until the source is repaired.

To upgrade history from an older file-backed installation, stop the Gateway
(`openclaw gateway stop`), back up its state (`openclaw backup create --verify`),
and run `openclaw doctor --fix` before restarting it with
`openclaw gateway start`.

Doctor migrates existing databases at every configured `agents.entries.<id>.agentDir`,
including custom paths outside the default agent tree and databases absent from the
registry. Configured session stores and retained legacy databases are also checked.
If a configured database still needs a schema migration after `--fix`, Doctor reports
its path and exits non-zero instead of printing `Doctor complete`.

`openclaw doctor --session-sqlite <mode>` provides targeted inspection,
import, validation, and SQLite maintenance. Legacy `sessions.json` files are
migration sources. Hot transcript JSONL files are imported and archived after
successful import; archive-tier JSONL files remain support artifacts, not
runtime fallbacks.

When a plugin migration is deferred, the verified import receipt also captures
unreferenced JSONL inputs. Completing the plugin migration archives those originals
with the same identity and byte checks as indexed transcripts. Files created after
capture and changed originals are verified separately before settlement.
Retries and read-only checks reuse the verified receipt, including transcripts
discovered outside `sessions.json`. Doctor reports one pending-plugin warning
for these retained inputs; they do not fail the completed core migration or
require `doctor --session-sqlite recover`. Warning-only results exit successfully.
An active legacy JSONL outside that receipt is an advisory awaiting verification.
`doctor --fix` and `--session-sqlite recover` compare its ordered entries against
the owning agent's SQLite transcript. Already imported history, including a
prefix of a longer SQLite transcript, is archived with a verified migration
receipt. Missing events go through the existing importer before verification;
current session settings and its active generation remain unchanged. Original
bytes stay in the migration archive for recovery. A changed, malformed, or
conflicting source that cannot be verified stays in place with a finding naming
that agent and file; a healthy agent does not inherit another agent's failure.
When the legacy index and live transcript inputs are gone, verified historical
archives keep their existing receipts. They do not require a new legacy-index
receipt or block post-session plugin repair. The plugin's completion releases
its retained configuration.

If the original `sessions.json` is unavailable but the completed import receipt
still identifies the canonical database, import rebuilds its source index from
the receipt's recorded hashes. It records that repair in the existing receipt
without recreating `sessions.json` or replaying session metadata. Hash-matching
sources continue through import; changed or unverifiable sources remain protected
and are listed by path. Preserve those files for inspection.

A restored copy with the recorded SHA-256 and size remains valid even when its
inode or modification time differs. `--session-sqlite recover` records its current
identity in the existing receipt, including when no failed migration manifest exists.
If the database file was replaced, recovery first verifies retained transcript
content against the current SQLite database before rebinding the receipt. Doctor
also verifies formatting-only index changes against the recorded source hash and
changed transcripts against complete canonical history. Verified content refreshes
the receipt without overwriting current session settings or resurrecting deleted
history. Changed index values and other unverifiable plugin inputs move to the protected
migration archive with their validation error and recovery path in the report.
For changed indexes, Doctor compares session keys and IDs with canonical SQLite and
names differing metadata fields in per-session warnings. This comparison does not
authorize replaying old values or accepting changed bytes as the original import.
Snapshot-path repair leaves these historical inputs unchanged.

A retained plugin source conflict does not prevent Gateway readiness after the
core import completed. Doctor owns the repair and the Gateway keeps serving SQLite.
`inspect` reports the actual SQLite row count even when retained input needs repair.
Recovery reports include every remaining issue code and distinguish unresolved
findings from completed validation.

When both a recorded legacy index and its archive are missing, Doctor verifies
the remaining transcripts against canonical SQLite before reporting that the
canonical transcripts are complete and the legacy index entries are informational.
It preserves those live transcripts and migration records, skips another import,
and allows post-session plugin repair to continue. It does not keep requesting
an import for that verified history.

Doctor also discovers primary conversation transcripts omitted from the legacy
registry, including timestamp-prefixed filenames. It verifies the session header,
file identity, and logical owner before importing. Known historical generations
remain attached to their existing session without changing its current generation
or settings. History with no registry owner is recovered as an archived session
only when its agent owner is unambiguous.

Rerunning import can recover primary history swept into protected archives by an
earlier migration. Doctor uses retained migration manifests and archived registry
lineage; it does not restore stale settings over live SQLite state. Originals stay
protected, and completed recovery is recorded so later runs do not resurrect
history explicitly deleted by the user. Diagnostic trajectory envelopes, deleted
artifacts, unsupported files, conflicting identities, and ambiguous ownership are
not converted into conversations. Deferred files remain available for recovery.

Repeated imports can leave multiple archived copies of one primary transcript.
Doctor treats copies of the same original path with the same verified size and
SHA-256 as one historical claim. It keeps one verified original and retires identical duplicates through
the existing recovery receipts, updating every retained
manifest. `--session-sqlite recover` also settles these archives even when the
latest failed run moved no files. Copies with different bytes stay protected and
are named in the warning; retained historical conflicts do not block update's
post-session plugin repair. Preserve the originals and migration manifests while
resolving those conflicts, then rerun `openclaw doctor --fix`.

### Changed archived registry

`historical_transcript_deferred` can report that an archived session registry no
longer matches its migration receipt. The receipt identifies the original file by
device, inode, modification time, size, and SHA-256; it is not an agent or install
ID. Copying, replacing, touching, or editing an archive can invalidate that receipt.
The identity format is the same in 2026.9.4 and 2026.9.5; 2026.9.5 added historical
archive discovery that checks these older receipts.

Doctor skips historical transcript import for that store and retains the originals.
This warning alone does not indicate SQLite corruption or require a rollback.
If all expected conversations are visible, no action is needed. You can inspect
current SQLite state with
`openclaw doctor --session-sqlite inspect --session-sqlite-all-agents`.

If history is missing, preserve the named archive and
`<state-dir>/session-sqlite-migration-runs/`, make a verified backup, and seek
recovery help with the warning and inspection output. Keep transcript contents
and raw manifests private. `doctor --fix` does not reset an unverified fingerprint;
do not delete or edit receipts to silence the warning. Import attempts record the
skipped outcome in their migration manifest and leave existing SQLite sessions
intact.

### Import staging and validation

The public Doctor migration path stages transcript payloads and performs branch
and provider repairs in a private, temporary SQLite database instead of retaining
complete histories in memory. It keeps the raw transcript untouched until archiving it through an
exclusive same-filesystem move, avoiding both an extra full `.pre-doctor` raw
copy and a rewritten intermediate file.

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
after cleanup. If a database is already in incremental auto-vacuum mode, has no
free pages, and has no WAL to checkpoint, import finalization verifies it once
and leaves its contents unchanged. Databases without auto-vacuum still need a
full `VACUUM` to enable it. Incremental cleanup frees unused pages but does not repack partially filled
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
| `recover`  | Restore a failed migration run, verify and archive leftover active JSONL files, and prepare a sanitized issue report.  |
| `restore`  | Restore archived transcript artifacts from recorded migration manifests without deleting SQLite data.                  |

Selectors:

- Default: the configured default agent store; SQLite inspection does not require a legacy file.
- `--session-sqlite-agent <id>`: one configured agent, or the expected database owner when paired with `--session-sqlite-store` (which otherwise assumes `main`).
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

Use `--yes` to authorize issue creation during noninteractive recovery. Without
it, redirected input, `--non-interactive`, and JSON output skip the prompt and
record why issue creation was skipped.

Recovery selects the latest failed migration manifest, restores only the
manifest's archived artifacts, validates the affected targets, and prepares
sanitized `.failure.md` and `.failure.json` reports when failure evidence exists.
Reports include the recorded run ID, failure timestamp (or `not recorded` for an
older journal without one), target, and failure code and error. They separate current
recovery findings from recorded migration and recovery evidence. A successful
recovery can have zero current issues while preserving earlier failures for
diagnosis; a target not inspected by this recovery is labeled accordingly.
When recovery has no work, no current issues, and no recorded failure, Doctor prints
`nothing to recover; no report filed` and does not prepare or open a GitHub issue.
The JSON report keeps the combined `issues` evidence and adds `recoveryIssues`
for inspected targets. The GitHub issue body avoids
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

### Hard-linked legacy artifacts

Doctor refuses a legacy `sessions.json` or transcript artifact when another hard
link references its inode. The diagnostic names the artifact path, device, inode,
and observed link count (`nlink`). Doctor does not scan for other linked paths.
The refusal protects snapshot copies from changes through a shared inode.

For a legacy source rejected before its identity was recorded for archival, stop
the Gateway and create a verified backup. Copy the contents to a **new** temporary
regular file in the same directory, preserving permissions. Verify that the copy
has identical contents and a link count of one, then rename it over the reported
source path and rerun the same Doctor command. Do not overwrite the source in
place or create another hard link: replacing its directory entry with the fresh
copy preserves the snapshot's contents without needing to find its other paths.

If an earlier migration was interrupted or the reported path is an archived
recovery artifact, preserve the files and manifests. Run
`openclaw doctor --session-sqlite recover` with the same profile and legacy-source
selectors first. Recorded artifacts depend on their original identities;
replacing them with copies can prevent restoration. If recovery still refuses
the artifact, retain that evidence for support instead of replacing it.

### Downgrading after session SQLite migration

Follow [Downgrade](/install/updating#downgrade) before starting an older release.
With writers stopped, `openclaw doctor --session-sqlite restore
--session-sqlite-all-agents` restores manifest-recorded legacy transcript
artifacts to their original paths. This supports recovery from retained originals;
it does not reverse SQLite schema migrations or replace a pre-update backup.

Run recovery before `openclaw update cleanup` retires those originals. After
cleanup, restore reports intentional disposal and cannot recreate them.
Shared-state discovery uses private read-only snapshots, including for custom
stores, so a refused restore leaves the shared database and its WAL unchanged.
Sessions created only in SQLite will not appear to an older file-backed runtime. If you
upgrade again, use the normal migration validation sequence above to compare
restored artifacts with SQLite rows before importing.
