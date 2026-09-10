---
summary: "Recovering from a failed `openclaw update`, plus the `update repair` and `update cleanup` subcommands"
read_when:
  - An update or repair failed and you need a working install back
  - You are running `openclaw update repair` and need its flags or exit codes
  - You want to inspect or retire migration recovery originals after an update
title: "Update repair and recovery"
sidebarTitle: "Repair and recovery"
---

What happens when an update fails, and the subcommands that finish the job. Part of the [`openclaw update`](/cli/update) reference.

## Recover a failed update

After a failed interactive update or repair, OpenClaw finishes cleanup and
opens [Triage](/cli/triage). Triage immediately starts the first directly
launchable coding agent on `PATH`, in this order: Claude Code, Codex, OpenCode,
then Pi. It passes the captured update failure directly and leaves fresh Doctor
checks and diagnostics collection to the agent, so a broken installation does
not delay the handoff. The agent keeps its existing authentication, sandbox, and
approval settings.

The agent starts in the operator's original working directory, or their OS home
if that directory is no longer accessible. The failed installation's resolved
state, config, and default workspace paths remain pinned for the repair.

Updates using `--yes`, `--json`, or a non-interactive session (including piped
input or output) collect diagnostics and print handoff commands without starting
an external coding agent. The updater's earlier
[unattended repair slot](/install/updating#unattended-repair-on-your-own-inference)
can still run on configured inference. With `--json`, triage output goes to stderr so stdout retains
the original update result. Diagnostic collection failures never hide the update
failure.

For a background or Control UI failure, use the installation-specific command
printed on the Gateway host. Printed commands use PowerShell on Windows and
POSIX shells on macOS, Linux, and WSL. When running triage manually, keep the same
profile and state/config overrides:

```bash
openclaw triage
openclaw triage --agent codex
```

Use `openclaw triage --non-interactive` to collect diagnostics without starting
an agent. Add `--update-result <path>` to include a saved update-failure artifact.

Validation failures leave the serving Gateway untouched. If stopping the managed
service unloads it and then fails before activation, OpenClaw attempts to restore
the verified original runtime after rechecking service ownership. After activation, a
failed verification can [restore the previous package](/cli/update/how-updates-run#validation-and-activation)
when database schemas are unchanged and the config file still matches the
candidate’s activation Doctor output. Preserve migrated state and
history; replacing the code alone cannot undo a migration. The original
failed update still exits nonzero after the agent finishes, even if the repair
succeeds.

Dry runs and commands rejected by the initial argument, external-supervisor,
state-store ownership, handoff identity, or immutable-config checks do not
collect diagnostics or start an agent. Once those checks pass, failed metadata,
schema, runtime, and managed-service checks enter triage even when installation
is blocked. This includes an update that cannot safely stop its parent Gateway
process. Diagnosis preserves that refusal: it does not stop the Gateway, retry
the update, or bypass safety checks. See
[Update troubleshooting](/install/update-troubleshooting).

## `update repair`

Rerun update finalization after the core package already changed but later
repair work did not finish cleanly. This is the supported recovery path when
`openclaw update` installed the new core package but post-core plugin sync,
managed npm plugin metadata, registry refresh, or doctor repair did not
converge.

```bash
openclaw update repair
openclaw update repair --channel beta
openclaw update repair --json
openclaw update repair --accept-capabilities
```

| Flag                                             | Description                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--channel <stable\|extended-stable\|beta\|dev>` | Persist the core update channel before repair. For extended-stable, eligible official npm and trusted official ClawHub plugins that follow bare/default or `latest` intent target the exact installed core version. Extended-stable repair is rejected on Git checkouts without changing config. |
| `--json`                                         | Print machine-readable finalization JSON.                                                                                                                                                                                                                                                        |
| `--timeout <seconds>`                            | Override each repair phase deadline in seconds. Defaults vary by phase (see below).                                                                                                                                                                                                              |
| `--yes`                                          | Skip confirmation prompts.                                                                                                                                                                                                                                                                       |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes while repairing plugin state.                                                                                                                                                                                                                   |
| `--no-restart`                                   | Accepted for parity; repair never restarts the Gateway.                                                                                                                                                                                                                                          |

`update repair` first inspects stale update history. When the installed Gateway
generation is healthy and the only remaining problem is an inactive ledger row,
repair records `failed` / `abandoned` and exits successfully without Doctor,
maintenance, or a service stop. It also acknowledges a Gateway-reconciled row
once within 30 minutes of reconciliation. Later repair invocations use full
finalization, so historical recovery cannot suppress plugin convergence.
Explicit recovery does not wait 30 minutes when every recorded updater process
is provably dead (its PID is gone or its process-start identity has changed).
Identityless rows and runs with an unrecorded adopter still require more than
30 minutes of inactivity; a recorded live or uninspectable driver blocks recovery.
JSON output identifies reconciled run IDs in
`reconciledRuns`, with `status: "ok"`, `mode: "repair"`, and `restart: false`.

Explicit channel or capability changes and known incomplete post-core work use
full finalization. Recorded activation, restart, verification, or finalization steps require
that convergence even if the Gateway has already reconciled the run. Repair
checks newer abandoned history as well as active rows; an older stale row cannot
hide unfinished work from a newer update. If the bounded history inspection is
incomplete, repair also uses full finalization. If that
work needs maintenance while the managed service is
running, stop the service through its owner before retrying. Doctor cannot stop
or restart the service on the update parent's behalf.
Successful full finalization then reconciles the selected stale rows before
reporting completion. Failed convergence leaves the selected rows intact. If any
selected run resumes before reconciliation, the whole selection is preserved.
Full finalization JSON includes `reconciledRuns` when stale rows were selected
for recovery, listing the IDs reconciled by that invocation.

For full finalization, `update repair` runs `openclaw doctor --fix`, reloads the repaired config and
install records, syncs tracked plugins for the active update channel, updates
managed npm plugin installs, repairs missing configured plugin payloads,
refreshes the plugin registry, and writes converged install-record metadata.
Configured runtime plugins whose versions follow OpenClaw are checked against
the newly installed core during post-update repair, even when the updater process
started on the previous version.
It does not install a new core package and does not restart the Gateway.
Human output ends with a finalization result that distinguishes completion,
completion with warnings, and failure.

When repair finds a configured npm plugin payload but cannot recover its install
record, it reinstalls from the selected registry source, using the active channel
or exact version pin. This requires registry access; if verification fails, repair
preserves the existing payload and does not publish a new install record.
Registry verification and any required capability review finish before the
repaired install record is published.

When a bundled plugin moves to an external package, failed relocation reports
that the replacement payload was not installed and preserves the underlying error.
Resolve that error before retrying with `openclaw update repair`.
Doctor and update repair reinstall configured payloads with missing package files
or a reported missing runtime entry;
an empty directory is not a successful installation. Rollback removes empty
managed npm projects after staged files are cleaned up. Doctor preserves external
companion packages and their install records even when a source checkout also
contains a bundled-discovery copy of the same plugin. Repair diagnostics must identify the recorded
package root; a broken same-ID source copy does not trigger replacement of a
healthy managed package.

With `--json`, stdout contains one JSON document. Doctor panels and other
diagnostics go to stderr, so stdout can be parsed directly. Failed doctor or
plugin finalization steps still exit non-zero.

Doctor repair uses the same enabled-plugin and default-check selection as
ordinary Doctor lint. Opt-in checks, including the managed Codex version probe,
do not run during routine finalization. Explicit candidate checks still run
when requested with `doctor --lint --only codex/managed-app-server`.
The version probe has a five-second deadline, terminates its process group
where supported, and bounds output draining when a descendant retains a pipe.
A timed-out probe cannot be accepted merely because its direct child exited
successfully. Nonfatal Doctor warnings appear in `postUpdate.doctor.warnings`;
finalization reports `status: "warning"` and exits successfully when no other
step fails. Codex runtime readiness remains owned by its plugin after restart.

Finalization (including the supervisor-facing `update finalize` command) records
phase starts and finishes immediately on stderr and in the update run ledger.
The defaults are 30 seconds for preflight admission, config validation, config backup, and completion
cache work; 120 seconds for Doctor migrations; 600 seconds for plugin registry
and installation work; and 180 seconds for post-plugin Doctor and validation.
`--timeout` overrides each phase budget.

A phase deadline produces exit code 1 and JSON with `status: "failed"`,
`stuckPhase`, `elapsedMs`, `error`, and the existing `phaseTimings` array. The
finalizer requests termination of its owned command trees before exiting.
Preserve the phase diagnostic when reporting a stalled update.

When a fresh Doctor ran in the timed-out phase, `doctorOutput` includes its
`phase` (`pre-plugin` or `post-plugin`) and separate `stdout` and `stderr`
diagnostics. Each stream reports `receivedBytes`, `lastOutputAgeMs` (`null` when
silent), and a redacted `excerpt` capped at 256 UTF-8 bytes. The failed phase's
ledger detail and stderr retain the same excerpts before exit. Capture is limited
to 64 KiB per stream; exceeding that cap replaces the text with
`omitted: "capture-limit"`. An incomplete private key or a redaction error also
omits the stream text. A recent output age indicates output receipt; it does not
prove that a migration advanced. Output and heartbeats do not extend the phase
deadline. These diagnostics do not establish that every descendant has stopped,
and must not be used as rollback authorization.

Shared CLI disposers have individual five-second deadlines. If the finalizer
remains alive ten seconds after its terminal JSON, stderr and the ledger
record active resource types and unsettled disposer names, then the process
exits with its recorded outcome. A retained handle cannot withhold the
supervisor's result indefinitely.
Both stall diagnostics also include `childProcesses`: up to eight descendant
processes with `pid`, `parentPid`, and an executable name (`command`). Arguments,
environment values, and executable paths are omitted. `childProcessesTruncated`
indicates omitted entries; `childProcessInspection: "unavailable"` means the
process list could not be read. A null `command` means that process's executable
name was unavailable. Inspection runs only after a stall and adds at
most one second to the exit bound. Phase-failure JSON includes the same fields.
Preserve these diagnostics and the phase receipts when reporting a blocked child.
Human repair can still wait for a recovery choice or repair agent; its exit grace
starts after recovery finishes. Completion-cache refresh remains best effort
when its child can be stopped within the phase budget. A phase that exceeds its
overall deadline still fails finalization.

Plugin artifacts that require capability consent are not installed without an
interactive review or explicit `--accept-capabilities`. `--yes` alone does not
accept capability changes, and JSON mode does not prompt. An unresolved review
preserves the previous plugin, exits non-zero, and blocks any requested Gateway
restart. This also applies when a bundled plugin moves to an external package or
a missing configured plugin has no install record yet. Automatic repair can
report a deferred replacement as a notice when a usable, enabled artifact remains
installed; that retained artifact still undergoes payload validation.

If the core package has already changed, run `openclaw update repair` in an
interactive terminal to review plugin capabilities. After reviewing the changes,
automation can use `openclaw update repair --accept-capabilities`. Acceptance
applies to each artifact's recomputed declared surface during this invocation;
it does not approve future capability additions.

## `update cleanup`

Retire migration recovery originals after you have verified that the upgrade and
session history work. Start with a preview, which can run while the Gateway is
active:

```bash
openclaw update cleanup --dry-run
openclaw --profile work update cleanup --dry-run --json
```

Cleanup targets the selected profile and `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`
overrides. It displays that state directory and does not redirect to a managed
service. Confirm the displayed directory is the installation you intend to clean.
`--dry-run` reads only configuration and recovery metadata, without opening
databases, taking a maintenance lock, loading plugins, or creating state.
Candidate bytes still require identity verification; historical artifacts are
listed separately as requiring verification. Protected and blocked artifacts
include reason codes.

Before applying, stop the Gateway for that same profile/state directory and wait
for other SQLite maintenance commands to finish. Stop database readers too,
including watchers that repeatedly run `openclaw sessions --all-agents --json`,
and keep them stopped until cleanup exits. Read-only SQLite connections can
create or change WAL/SHM sidecars, invalidating cleanup's destination check even
when session content is unchanged. If cleanup reports `Recovery destination
database changed; preview cleanup again.`, stop those readers, preview again,
and retry. Cleanup requires exclusive offline state ownership and never stops
or restarts a service itself.

<Warning>
Cleanup permanently removes the selected rollback originals, including branches
and metadata intentionally removed by a verified repair. Doctor restore cannot
recreate them afterward. Keep them, or preserve an independent backup containing
them, if you still need that rollback path. Current SQLite history stays in place.
</Warning>

```bash
openclaw update cleanup
openclaw update cleanup --yes --json
```

Interactive confirmation defaults to **No**. JSON mode never prompts or grants
consent; unattended deletion requires `--yes`. Consent does not override
ownership, file identity, or dependency checks. Applicable flags (`--dry-run`,
`--yes`, and `--json`) work before or after `cleanup`; update-only flags
`--channel`, `--tag`, `--timeout`, `--no-restart`, and `--accept-capabilities`
are rejected.

Only owner-recorded recovery artifacts with complete import evidence are
eligible. Unknown or unimported history, malformed inputs, trajectories,
forensic corrupt databases, operator backups, and unmanifested artifacts stay
protected. Old manifests are verified offline where possible; missing evidence
is a reason to retain an artifact. Cleanup has no automatic expiration policy.
Private package, command-shim, and Git runtime backups remain owned by the update
transaction and are outside this migration cleanup. An interrupted entry in update
history does not block cleanup of otherwise eligible migration archives.

The JSON result contains `stateDir`, `status`, `artifacts`, and `totals`. Each
artifact reports its path, run ids, logical bytes, outcome, and reason. Totals
separate candidates, verification-required, protected, blocked, and removed
bytes. Removal failures exit nonzero. Keep the recovery manifests and rerun
cleanup to finish recorded interrupted work; a retry does not delete a recreated
file. Removed logical bytes do not promise
equivalent physical space reclamation on cloned or snapshotted filesystems.
When a path cannot be inspected, its logical size comes from recorded artifact
metadata when available. Cleanup records durable intent before removal and uses
exclusive no-copy publication. Failures are reported; retries reconcile file
operations that already completed. Manifest files are synchronized before removal;
parent directories are synchronized where supported. Windows does not provide the
same parent-directory durability guarantee.

Doctor restore reports intentionally disposed originals and pending cleanup
explicitly. Neither update nor cleanup creates an automatic full-state backup;
these recovery originals are **not a full pre-upgrade backup**. See
[Before updating: create a verified backup](/install/updating#before-updating-create-a-verified-backup)
for backup coverage and [Doctor recovery](/cli/doctor#session-sqlite-migration)
for restoring retained originals.
