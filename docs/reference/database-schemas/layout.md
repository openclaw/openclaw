---
summary: "Which SQLite database holds what, and the tables behind individual features"
read_when:
  - "Locating the global state database or a per-agent database on disk"
  - "Checking which table backs a feature such as the update ledger or meeting transcripts"
title: "Database layout"
---

## Database layout

| Scope                | Default path                                               | Contents                                                                                              |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Global control plane | `~/.openclaw/state/openclaw.sqlite`                        | Shared configuration state, registries, approvals, plugin state, and shared runtime state             |
| Per-agent data plane | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | Sessions, transcripts, memory indexes, auth state, conversation state, and agent-scoped runtime state |

The task registry uses the global control-plane database. Runtime trajectory events live with their sessions in the per-agent database or a configured shared session SQLite store.

### Plugin state listing index

Plugin keyed stores use the shared `plugin_state_entries` table. Its listing
index includes `expires_at` after the existing plugin, namespace, creation-time,
and entry-key columns, so live-row counts can read the index without fetching
stored values. Quotas, TTL cutoffs, ordering, and row contents are unchanged.

Writable startup and `openclaw doctor --fix` replace the older four-column
definition through canonical index repair, without a schema-version bump. The
repair builds temporary indexes and runs the existing table and full-file
integrity checks; allow for extra disk space and work proportional to stored
entries during the first repair.

An older build can rebuild the same index back to its expected definition.
Full-schema read-only validation rejects a mismatched definition until a
writable owner repairs it; lightweight readers that validate only the numeric
schema version may read either shape. See the
[accepted index design](https://github.com/openclaw/openclaw/issues/142244) for
upgrade, reverse-repair, and performance proof requirements.

### Mentions Inbox

The [mentions Inbox](/concepts/multi-user#temporary-mentions-inbox) uses existing
`config_machine_state` rows in `state/openclaw.sqlite`.
`notifications.mentions.source.*` records retain typed source identities,
recipients, mention identifiers, expiry times, and dismissal bookkeeping;
`notifications.mentions.head` records the revision and sequence. Writes use the
existing table and primary key, with no new tables, columns, indexes, or schema
version change.

Retention remains seven days from creation, capped at 100 entries per profile,
10,000 entries globally, and 10,000 source identities for duplicate suppression.
Restarts preserve retained entries, dismissals, and their original expiry times.
Loading stored state does not replay browser notifications or scan transcripts
to reconstruct old mentions.

### ACP replay accounting

The shared `acp_replay_sessions` and `acp_replay_events` tables retain bridge
replay history. Their `estimated_bytes` columns count the UTF-8 bytes of each
persisted text field, plus 32 bytes per row. Session totals include their events.
This is a retained-content estimate, not a limit on SQLite file, page, or WAL size.

Older releases counted characters inconsistently, undercounting Unicode and
allowing unchanged metadata writes to drift. The existing app-version upgrade
repair and explicit shared-state schema repair rebuild all derived totals
atomically, preserving event JSON text, identifiers, timestamps, and sequence.
Repair does not prune history. The next ordinary session write applies the
existing caps and eviction order, so corrected Unicode history may trim sooner
and use transcript fallback when loaded.

A current-app-version reopen skips this repair. Replacing code without changing
the app version does not repair an already-open or current-version database;
explicit schema repair remains the repair owner for that case. Accounting repair
cannot recover history already evicted by an older writer. See [ACP CLI](/cli/acp).

### Meeting transcript tables

Meeting captures use three `STRICT` tables in the shared
`state/openclaw.sqlite` database, separate from per-agent conversation transcripts.
The transcript store (`src/transcripts/store.ts`) owns their reads and writes;
`src/transcripts/sqlite-schema.ts` ensures the tables on first use. Markdown and
JSON files under the transcripts directory are explicit exports, not runtime
storage. See [Transcripts CLI](/cli/transcripts).

#### `meeting_transcript_sessions`

One row per capture identity. The primary key is `(session_id, started_at)`;
`selector` is unique. Indexes support start-time, session-ID, slug, and export-key
lookups.

| Columns                                  | Type                                        | Purpose                                                                 |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `session_id`, `started_at`               | `TEXT NOT NULL`                             | Capture ID and original start time.                                     |
| `selector`, `export_key`, `session_slug` | `TEXT NOT NULL`                             | Canonical selector and derived export identity.                         |
| `provider_id`, `source_json`             | `TEXT NOT NULL`                             | Source provider and locator.                                            |
| `title`, `stopped_at`, `metadata_json`   | Nullable `TEXT`                             | Display title, terminal time, and session metadata including ownership. |
| `export_manifest_json`                   | `TEXT NOT NULL`, default `{}`               | Export artifact ownership manifest.                                     |
| `export_pending_json`                    | `TEXT NOT NULL`, default `[]`               | Pending export artifacts.                                               |
| `next_utterance_seq`                     | Nonnegative `INTEGER NOT NULL`, default `0` | Next append sequence.                                                   |
| `created_at_ms`, `updated_at_ms`         | Nonnegative `INTEGER NOT NULL`              | Store timestamps.                                                       |

Reopening an occupancy-driven capture clears `stopped_at` without changing the
primary key, so the same meeting retains its utterances.
New transcript admissions record `sessionIdOrigin` (`generated` or `supplied`)
in `metadata_json`. The store preserves that value, including its absence or
invalidity in legacy rows, on later writes to the same primary key. Occupancy
reopening requires an explicitly generated origin; an unknown origin starts a
fresh capture and leaves the old record intact. The existing newest-candidate
query and ten-minute window are unchanged.

This adds no schema, index, version, or backfill. Doctor metadata restoration
preserves an explicitly recorded origin and leaves unknown origins unknown.
Older runtimes do not enforce this rule, so downgrading also removes the fixed-ID
history protection. See the [accepted ID-origin decision](https://github.com/openclaw/openclaw/pull/130860).

#### `meeting_transcript_utterances`

Append-ordered speech records. The primary key is
`(session_id, session_started_at, sequence)`; the session pair references
`meeting_transcript_sessions(session_id, started_at)` with `ON DELETE CASCADE`.

| Columns                                  | Type                           | Purpose                                          |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `session_id`, `session_started_at`       | `TEXT NOT NULL`                | Owning capture identity.                         |
| `sequence`                               | Nonnegative `INTEGER NOT NULL` | Stable append order within the capture.          |
| `utterance_id`, `started_at`, `ended_at` | Nullable `TEXT`                | Provider utterance identity and timing.          |
| `speaker_id`, `speaker_label`            | Nullable `TEXT`                | Provider speaker identity and display label.     |
| `text`                                   | `TEXT NOT NULL`                | Captured transcript text.                        |
| `final`                                  | Nullable `INTEGER`, `0` or `1` | Whether the provider marked the utterance final. |
| `metadata_json`                          | Nullable `TEXT`                | Provider utterance metadata.                     |

#### `meeting_transcript_summaries`

One current summary per capture. The primary key is
`(session_id, session_started_at)` and references the session primary key with
`ON DELETE CASCADE`. At least one of `summary_json` or `markdown` must be non-null.

| Columns                            | Type                           | Purpose                                                                                                     |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `session_id`, `session_started_at` | `TEXT NOT NULL`                | Owning capture identity.                                                                                    |
| `generated_at`                     | Nullable `TEXT`                | Summary generation time.                                                                                    |
| `summary_json`                     | Nullable `TEXT`                | Free-form summary, including participants, `source` (`model` or `heuristic`), and optional model reference. |
| `markdown`                         | Nullable `TEXT`                | Rendered meeting notes.                                                                                     |
| `utterance_count`                  | Nonnegative `INTEGER NOT NULL` | Number of utterances covered by the stored summary.                                                         |

These are existing feature-local tables. Occupancy episodes and model-backed
notes do not change their schema or database version.

### Update run ledger

`update_runs` stores one durable record per update in the shared
`state/openclaw.sqlite` database. `src/infra/update-run-ledger.ts` owns writes
from the admitting Gateway, orchestrator CLI, and restarted Gateway. The table
is additive at shared schema version 15: the canonical schema declares it and
first use ensures it inside the same write transaction. Existing tables and the
schema version stay unchanged; older readers ignore the new table.

`run_id` is the UUID primary key. Rows retain creation/update timestamps,
trigger, phase, status, reason, origin, target, before/after versions, steps,
verification facts, repair attempts, confirmation/finish timestamps, and known
downtime. Each JSON column has a 16 KiB hard limit with deterministic truncation
and redaction. The ledger stores bounded diagnostic summaries, not raw logs or
credentials. There is no automatic history deletion.

New drivers store optional `origin.driver` fields `host` (the hostname), `pid`,
and `startIdentity` (the operating system's process-start identity as a decimal
string) in the existing `origin_json` column. Each adopter becomes the current
driver and retains distinct earlier identities in `origin.previousDrivers`.
There are at most eight identities in total. Only positively dead identities
are pruned; adoption is refused rather than dropping a live or uninspectable
driver at capacity. If local process identity cannot be captured, adoption
continues with one warning and a retained `driver:identity-unavailable` step.
That marker permanently excludes the run from automatic reconciliation, even
if known parents later exit; existing recorded identities remain protected.
A fresh run without identity follows the legacy explicit repair/supersession
rules below.
This is additive JSON metadata;
there are no new columns, tables, or schema versions. The separate
`verification.pid` still identifies the Gateway service, not the updater.
Adoption records a retained `driver:adopted` step. Detached children can outlive
their parent, so either lifetime can prevent reconciliation. Adopting a terminal
run is refused. Long command and finalization phases renew `updated_at_ms`
every 30 seconds; only current or retained identities may renew a row. Heartbeat
write failures warn once per driver run and do not abort commands or finalization;
step and outcome writes retain their existing failure behavior. Encoding
reserves space for exact identity bytes before bounding and redacting other
origin diagnostics.

The ledger owns abandonment classification and terminalization. Automatic
recovery requires more than 30 minutes since both `updated_at_ms` and the latest
step timestamp, plus positive evidence that every recorded driver is dead on the
same host: its PID is gone or its process-start identity differs. Unreadable and
foreign-host identities are inconclusive. The Gateway performs reconciliation
at startup and on active-run polls, rechecking the current row and process
identity in the terminal write transaction. The shared 30-minute constant also
owns the older-updater schema-publication bound described under
[Schema bumps and older updaters](/reference/database-schemas/versioning#schema-bumps-and-older-updaters).

Reconciliation writes status `failed`, reason `abandoned`, and a retained
`reconcile:abandoned` step whose detail names `inactive-driver-dead` or
`operator-reconciled-inactive-run`. All unfinished steps become terminal, and
history is retained. Explicit `update repair` can reconcile inactive identityless
rows when the current Gateway generation is healthy and no post-core repair is
pending. When every recorded driver is positively dead and no
`driver:identity-unavailable` marker exists, explicit recovery does not require
the inactivity window. It cannot override a live or inconclusive recorded driver. The
[2026.9.2 updater](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command.ts#L465)
does not record adoption: package-manager and registry preflight can
leave a live updater at its single `requested/in_progress` step. Older writers
may drop unknown driver JSON fields; identityless rows require explicit recovery.
`update status` only reports classification and never commits reconciliation.

Explicit new CLI update admission can supersede a legacy row only when it is
the sole running row, has no current or previous driver identity, and exceeds
the same inactivity bound. The transaction finishes it as `failed` with reason
`superseded` and a retained `reconcile:superseded` step whose detail is
`operator-started-update-supersedes-inactive-identityless-run`, then creates the
new row. This includes dry-run admission, but excludes inherited continuations
and campaigns. `abandoned` and `superseded` are additive values in the existing
free-text reason contract. Neither recovery path deletes history.

Successful ledger-only repair records a retained `reconcile:acknowledged` step.
A terminal abandoned row can substitute for full repair only once, within
30 minutes of its finish time; later repair invocations keep normal plugin
convergence behavior.
Repair also inspects newer failed/abandoned history for unacknowledged post-core
work, regardless of its age. An older active row cannot hide that work. If the
bounded history prefix does not reach the selected recovery rows, repair uses
full finalization rather than claiming that no post-core work remains.
When full finalization is required, the selected inactive rows are rechecked
and reconciled only after successful convergence, before success output.
Explicit recovery validates and commits its selected rows in one transaction;
renewed activity in any selected run preserves the entire selection. Ledger-only
repair also refuses the write if another active run falls outside that selection.
Finalization (`finalize:*`) and post-update verification markers survive step-count
and diagnostic-byte eviction because repair relies on that history. If retained
metadata alone exceeds a hard limit, the write fails without changing the row.

The CLI and Gateway share WAL-backed transactions, including while the Gateway
is stopped. The first terminal outcome wins; subsequent verification can enrich
its observed facts without rewriting success, failure, skip, or rollback status.
The restart sentinel carries `stats.runId` and remains the continuation owner;
consuming it does not delete the run row. Chat, CLI, and status reports read that
row. See [Run history and reports](/cli/update#run-history-and-reports).

### Cloud repository workspaces

Repository-only [cloud sessions](/gateway/cloud-workers#dispatching-a-session) use the first-use `session_repository_workspaces` table in the shared state database. The existing session entry carries only `repositoryWorkspaceId`; the shared row owns the canonical agent/session key, repository URL, requested ref, session branch, setup intent, pinned base commit and manifest, accepted checkpoint pointer, and revision. Session reset preserves this owner; a fork receives a distinct owner.

`github_repository_publication_requests` records shared and personal publication against an immutable accepted checkpoint and the session's admitted lifecycle revision. Reset preserves the session ID and repository checkpoint but invalidates publication authorized before that reset. Personal requests also retain the selected profile and connection generation and require same-owner confirmation after an interrupted publication. Pending publication keeps its original source even after an explicit move materializes a Gateway worktree.

Both tables are additive, lazily ensured on first use, and leave the numeric database schema version unchanged. That is not a compatibility promise for older cloud-session implementations: run a build that understands repository-only sessions when using this state. Existing local managed-worktree sessions keep their existing representation.

Checkpoint Git artifacts live under `state/repository-workspaces/<workspace-id>.git`, next to the shared database. These are bare repositories containing complete file manifests, cumulative changed-file blobs, and publication snapshots; they are not working checkouts or a backup of upstream Git history. Restoring an entire checkout still requires access to the pinned upstream commit. Back up these artifacts together with the shared and per-agent databases.

Accepted checkpoint history and publication source artifacts remain until explicit session deletion, including after Stop, archive, reset, or Gateway restart. There is no timed checkpoint expiry. Deletion retires publication requests and source ownership before removing their artifact repository; failed cleanup is reported. The managed-worktree idle cleanup and snapshot retention rules do not apply to these checkpoints.
