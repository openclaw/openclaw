---
summary: "Downgrading, automatic state and package rollback, verified pre-update backups, and triage when an update leaves you stuck"
read_when:
  - Something broke after an update and you need to go back
  - You want to know when `openclaw update` can roll back automatically
  - You are creating a verified backup before a significant update
  - An update failed and you need triage or unattended repair
title: "Rollback and recovery"
---

Downgrades, automatic rollback, verified pre-update backups, and triage when an update leaves you stuck. Part of the [Updating](/install/updating) guide.

## Downgrade

Verify the upgrade and your session history before retiring recovery originals
with `openclaw update cleanup`. Downgrading the package does not reverse config
or database migrations. Once state has migrated beyond the older release's
supported format, the supported recovery is to restore a verified pre-update
backup with its matching OpenClaw release.

Prefer `openclaw update` for upgrades and recovery. It validates the target,
backs up inventoried state before required Doctor migrations, and verifies the activated Gateway. A raw
`npm i -g` replacement does not retain the previous package or run this recovery
workflow; use `openclaw update` or [create a backup first](#before-updating-create-a-verified-backup).

The updater retains the previous package during activation and keeps it when
failed recovery cannot prove a working installation. Migration recovery originals
remain until explicit [update cleanup](/cli/update#update-cleanup). These are
separate recovery mechanisms: cleanup does not manage package or Git runtime
backups or [update recovery sets](/cli/backup#update-recovery-sets), and retained migration originals are not a full pre-update backup.
Preserve every recovery location named in the update report until you have
verified the installation.

For a target that can read the current state, preview and use the managed
rollback path:

```bash
openclaw update --tag <known-good-version> --dry-run
openclaw update --tag <known-good-version>
```

The updater checks compatibility and asks for downgrade confirmation. If the
saved channel is `extended-stable`, add `--channel stable` for an exact one-off
tag. Supported targets finalize the config writer stamp, restart the service,
and verify the running version. Older targets may lack that finalization or
migration-continuation contract; follow the printed recovery guidance if
activation is refused. Do not bypass a newer-schema or newer-config refusal.

When the update report identifies retained originals, use the corresponding
[Doctor recovery command](/cli/doctor#session-sqlite-migration) before cleanup.
Restoring legacy session artifacts does not reverse SQLite schemas or restore
sessions created only in SQLite. If the older release cannot read the current
state, restore the pre-update backup using [Restore a full archive](/install/backups#restore-a-full-archive).
Keep the Gateway and other writers stopped throughout activation of the restored
state, and preserve the current state separately first: restoration discards
changes made since the backup. Reinstall the matching package through the
installation's package manager; a backup archive does not contain the package.

A complete recovery point must cover these together:

- The matching OpenClaw package version or source revision and built runtime.
- `openclaw.json` and its `$include` files, including `meta.lastTouchedVersion`.
- `state/openclaw.sqlite` and every `agents/<id>/agent/openclaw-agent.sqlite`,
  including databases at configured paths outside the default layout.
- The workspaces, credentials, and retained originals needed by that installation.

Use `openclaw backup` for a verified, WAL-aware archive. Never copy only the
main `.sqlite` file from a live WAL database: committed data can still be in
`-wal`. Restore the verified consolidated database offline; do not mix it with
`-wal` or `-shm` files from another database generation. See [Backup](/cli/backup)
for archive coverage and omissions.

Versions with the [startup preflight repair](https://github.com/openclaw/openclaw/pull/141451)
leave configuration, databases, and migration inputs unchanged when preflight
refuses startup. A successful start can migrate state forward. An older binary may then refuse
both the database schema and the config's `meta.lastTouchedVersion`; changing
either version marker does not undo the migration. Repair the installed version
with `openclaw doctor --fix --non-interactive`, or use the backup recovery above.

During recovery, prevent an enabled [auto-updater](/install/updating/automatic-updates#auto-updater) from immediately
reapplying the newer release by setting `OPENCLAW_NO_AUTO_UPDATE=1` in the Gateway
environment.

After recovery, verify the running installation before cleanup:

```bash
openclaw --version
openclaw health
openclaw gateway status --deep --json
openclaw doctor --lint --json
openclaw update cleanup --dry-run
```

<a id="automatic-checkpoint-recovery" />

### Full-state recovery requires a backup

The current updater creates an `update-recovery` set before protected config,
plugin, or Doctor mutations. It uses SQLite's online backup API to retain unsanitized database
contents, plus the config, includes, and other inventoried local migration
resources. Every file has a verified size and SHA-256. The set is stored at
`<stateDir>.update-captures/<captureId>/` with owner-only permissions, and its
path is recorded in the update run. The shared privacy marker excludes it from
ordinary backups, Doctor archives, and support exports, including containing or
nested workspace selections. [Update recovery sets](/cli/backup#update-recovery-sets)
describes the inventory and capacity admission that precede protected mutation.

The capture's own update may retire it only after durable terminal success,
verified runtime identity and data compatibility, settled mutating children,
and no remaining recovery dependency. There is no age, count, or disk-pressure
pruning. Failed, restored-after-failure, and unresolved captures remain available
until explicit recovery resolves them; deliberate backups and historical
recovery evidence are never cleanup targets.

If activation or later verification fails, the current updater restores the
previous package and that verified set, then verifies the previous managed
Gateway's health and identity. A schema migration alone no longer blocks this
recovery. Config changes by another writer and package-manager ownership changes
still require intervention. A verified rollback retains the original failure
and exits nonzero. With `--no-restart` or no managed service, file restoration
does not claim that a Gateway was restarted or verified.

When the core is already current, config or plugin changes still receive the
same protection. A failure restores the captured state without inventing a
package rollback for an unchanged core. A true no-op neither captures state nor
stops the Gateway. Standalone `openclaw update repair` also captures before its
first mutation and can restore state after its mutating children settle. It
never starts the Gateway, even on success, and retains its set for explicit
Doctor resolution because it has not verified runtime health.

A missing, corrupt, or unrestorable set is a hard failure. Preserve the path
named in the report, keep an unverified Gateway stopped, and let the update and
Doctor processes exit before running:

```bash
npx openclaw@latest doctor --fix
```

Run this on the Gateway host with the same profile, state, and config selection.
If a compatible newer OpenClaw binary is already installed, use
`openclaw doctor --fix`. A retained capture blocks another protected update.
Inspect it first with `openclaw update status --json`. Doctor reconciles the
capture with the exact update run before choosing a restore: completed updates
and recorded restorations are stale captures, so newer live data stays intact.
For an unresolved failed run, Doctor verifies the set and checks that the
Gateway and recorded update owners have stopped before restoring it. Missing,
unreadable, or ambiguous history refuses restoration. Successful explicit
Doctor repair can resolve and retire the retained set. These commands cannot
reconstruct a missing backup; preserve any surviving state and
use an independent verified backup when the report says no usable set exists.
Remote services and undeclared external plugin resources are outside this local
inventory and need their own recovery procedure.

The explicitly declared, unsupervised Git update inside a serving Gateway does
not create a recovery capture. Its result and status warn that a terminal
`openclaw update` is required for protection. Existing ownership, maintenance,
and schema checks still apply; see the
[inline Git follow-up](https://github.com/openclaw/openclaw/issues/144422).

An existing pending checkpoint-recovery record blocks further mutable updates.
The updater reports that it is unsupported and leaves its records, backups, and
state unchanged. Do not remove or alter retained artifacts to force a clean
status, and do not use `update finalize` to bypass the refusal. Preserve the
reported locations for a compatible recovery implementation or an independent
verified backup. An interrupted or refused restore is not a successful rollback.

### Recovery with older updaters

The target Doctor detects whether its caller supplied a verified update-recovery
set. When an older updater supplies none, Doctor binds its capture to the one
admitted update run and verifies the same kind of set before migrating. Missing
or ambiguous update ownership refuses the protected mutation. If migration or verification fails within that
Doctor invocation, it restores the set before exiting nonzero, so the older
updater can restore package files without leaving forward-migrated databases.

The published 2026.9.2 updater leaves the Gateway stopped after its package
rollback. Once it finishes and the report confirms state restoration, stay on
that release with:

```bash
openclaw gateway start
openclaw gateway status --deep --json
```

Alternatively, run `npx openclaw@latest doctor --fix` to continue repair with a
newer compatible binary. This runs Doctor without replacing the installed
package; if repair migrates state forward, install a release that supports that
state before starting the Gateway. The failure output names both paths and the retained
backup. This is best-effort support for the old driver: if Doctor succeeds and
2026.9.2 fails later, that updater has already discarded its package backups.
The target Doctor cannot automatically roll back a failure after its invocation
has completed. A successful old-driver Doctor records its completion on the
parent run, but does not finalize that run or retire the capture: its success
does not prove the whole update passed runtime verification. The retained set
requires explicit inspection and Doctor repair before another protected update.

### Automatic schema-neutral rollback

When no verified update-recovery set is available, the compatibility-only
package rollback path remains limited to unchanged database formats. If a newly
activated package fails verification, `openclaw update` compares the
shared and affected per-agent SQLite applied schema versions, including deferred
content versions, with their pre-activation values and checks that the config file still matches the content
reported by the candidate’s activation Doctor writer.
Databases first created during activation or verification are
schema-neutral when their version matches the candidate's supported version for
that database kind. A changed schema version or missing pre-existing database,
or a new database at a foreign version, still blocks rollback. Before restoring
code, the updater also checks that the previous package supports any new database;
unknown or incompatible support refuses rollback with `rollback-state-unverified`.
When both checks pass and the retained previous package was verified before the
update, it stops the candidate and restores the previous generation: package,
command shim, service definition, and exact pre-activation config bytes, including
the previous writer stamp. Config replacements use owner-only permissions (`0600`);
unchanged config needs no write. Owned, writable
service metadata is refreshed; protected service definitions are preserved.
The CLI verifies the restarted previous Gateway's service health, version/build
identity, plugins, channels, and `/readyz` again. Update verification does not use
model inference: the managed service must be running and own its port, and the
Gateway hello handshake must match the expected artifact.

The candidate’s own Doctor migrations in the main config file do not block rollback, including on
a fresh install’s first update. The updater retains the config immediately before
Doctor and verifies that Doctor consumed those captured bytes before making changes.
It also checks the current file against the output hash reported by Doctor’s writer.
Rollback restores the original bytes only while both hashes match. Restoration
holds the normal config writer lock and rechecks the hash after acquiring it. Operator edits
made after activation block restoration, including edits before Doctor reads the
config and between Doctor’s last write and the updater’s capture. Separate `$include` files must retain
their pre-activation configuration content; they are not restored by the root-file
snapshot. The existing intentional-recovery
allowance applies only to service commands, so the older-binary guard does not
block recovery; it is never saved in config or the service environment.

Successful recovery leaves the previous Gateway running and finishes the run as
`rolled-back`, with `after.version` set to the previous version and downtime
measured from service stop through verified recovery. The headline is
`↩️ OpenClaw update rolled back to <previous>: <reason>`, retaining the original
verification failure. The command still exits nonzero; recovery does not turn a
rejected candidate into a successful update.

Use `openclaw update status` for the recorded reason and `openclaw triage` to
diagnose a failed check. Recovery guidance reports whether the Gateway is running
or stopped from the latest service observation, even when a running candidate did
not pass verification. A restored Gateway must pass its own verification checks
before the run can finish as `rolled-back`.
Automatic triage never follows a verified rollback; it runs only when the update
ends failed. In an interactive terminal, you can choose **Diagnose update failure**,
**Report update failure**, or **Exit**, which is selected by default. Reporting
shows the sanitized preview and requires separate confirmation before issue
creation. Skipping or cancelling does not start diagnosis or submit a report.
JSON, `--yes`, non-interactive, and managed-service handoff invocations do not
show this menu after rollback.

On this compatibility-only path, if the config file changed after the activation Doctor pass or the databases are
not schema-neutral, rollback is refused with
`state-migrated-no-rollback`. For config edits, the next action names the file
whose changes blocked restoration. The updater attempts
[bounded unattended repair](/install/updating#unattended-repair-on-your-own-inference)
on the installed candidate, preserving migrated state. The same repair slot can
run if rollback itself fails, targeting the previous release if its package was
already restored. If repair cannot pass verification, the update
fails with the original reason and recorded repair attempts. Use `openclaw triage`
or the printed repair command before considering an older version.
This compatibility-only rollback restores code and the captured config without a state recovery set.
The candidate's temporary migration-rehearsal snapshots are removed after
validation and do not replace your backup.
If the schema comparison cannot be completed, automatic rollback is refused
(`rollback-state-unverified`). The freshly installed candidate owns final
verification and reporting after migration,
preserving the same run ID and recorded activation steps.

For pnpm and Bun, changes to sibling global packages after staging refuse automatic rollback (`rollback-project-changed`) without restoring the shared project; keep a reachable candidate installed, otherwise keep the Gateway stopped and follow the report’s repair command.
A refusal before the live swap restarts the unchanged Gateway and preserves the sibling changes.

### Before updating: create a verified backup

The automatic update capture protects inventoried local migration resources
for that update transaction. Before a significant update, also create an
independent verified backup for long-term recovery:

```bash
mkdir -p ~/Backups/openclaw
openclaw backup create --output ~/Backups/openclaw --verify
```

The archive manifest records the OpenClaw version and the source paths included
in the backup. The archive can contain credentials, auth profiles, and channel
state, so store it with owner-only permissions and the same protection as the
live state directory. See [Backup](/cli/backup) for included and intentionally
omitted files.

For a byte-for-byte recovery point that includes volatile artifacts omitted by
the portable archive, stop the Gateway and use a filesystem, volume, or VM
snapshot provided by your platform. This matters for older file-backed installs:
the portable archive omits matching JSONL transcripts and logs even when they
are no longer being written.

When migrating large legacy histories, leave room for the original files, a
temporary SQLite spool, and the destination database/WAL simultaneously. SQLite
can be larger than the original JSONL; streaming import does not imply a fixed
RAM requirement or migration time. Check free space on both the system temporary
volume and the state volume. See [Session SQLite migration](/cli/doctor#session-sqlite-migration)
for staging and memory details.

## If you are stuck

Run `openclaw triage` in a terminal on the Gateway host, using the printed
installation-specific command or keeping the same profile and state/config
overrides. It opens the first directly launchable coding agent in this order:
Claude Code, Codex, OpenCode, then Pi. The agent receives local diagnostics and
any recorded failed-update outcome so it can repair the installation and verify
Gateway health, using its normal authentication, sandbox, and approval settings.
Use `openclaw triage --agent codex` to select a particular agent.

Failed interactive updates offer triage after updater cleanup and
pass the captured failure to the agent before fresh diagnostics can delay the
handoff. Before launch, OpenClaw shows the agent, saved prompt path when available,
and use of your own account/tokens; Enter or `y` proceeds, while `n` prints handoff
commands and preserves diagnostics and the failed update's exit status.
After 30 seconds without an answer, it announces that it is continuing and
proceeds as Yes; explicit `openclaw triage` does not ask for this confirmation.
JSON, `--yes`, and non-interactive update invocations collect diagnostics
and print handoff commands without starting an agent. For diagnostic collection
alone, use `openclaw triage --non-interactive`; add `--update-result <path>` to
include a saved update-failure artifact. See [Triage](/cli/triage) for command
formatting and installation targeting.

Triage keeps the failed update's report intact. An update started during repair
creates its own history entry. After package replacement, restart commands run
from the updated installation. A restart accepted by the service owner can still
fail readiness checks; inspect `openclaw gateway status --deep` before retrying.

Keep a stopped, unverified Gateway stopped and preserve migrated state during
repair. A reachable candidate retained after a schema migration can continue
serving while you diagnose it.
The failed update retains its nonzero exit code even if the agent repairs it.

- For `openclaw update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

### Unattended repair on your own inference

The updater enters the optional `repairing` phase when candidate Doctor lint,
config validation, plugin resolution, or canary startup fails. It repairs the
staged candidate and reruns the failed check while the old Gateway keeps serving.
Only a passing validation allows activation; otherwise the update fails and
discards the candidate without stopping the service.
Before activation, repair shares one disposable rehearsal state/config snapshot
across its turns and validation, then independently validates surviving candidate
changes before activation; configuration changes are never promoted and
stop as `repair-requires-config-change`, naming the changed top-level keys for
the operator to inspect with `openclaw triage` or apply with `openclaw doctor --fix`.

Git source updates keep the selected source revision. Repair may restore
dependencies, generated runtime files, or state, but a candidate with changed
tracked source fails before the Gateway stops; fix the source revision before retrying.

After activation, the updater can also enter `repairing` when verification fails
and config edits after the activation Doctor pass prevent rollback, a schema
migration has no verified update-recovery set, or
when rollback itself fails. This repair targets the runtime that remains
installed and preserves migrated state. After each turn, the updater starts or
restarts a stopped or unhealthy service once, then reruns the service, version,
and `/readyz` checks. A verified candidate repair allows the run to succeed. If
rollback already restored the previous release, successful repair finishes
`rolled-back` and the command still exits nonzero. Otherwise the original failure
and repair summary remain in the final report.

During finalization on Windows, the updater restores Scheduled Task autostart
for activation and suspends it again if final verification fails. This ownership
survives the fresh-process handoff required after a state migration. See
[Failed update recovery](/gateway/restart-recovery#recovery-after-a-failed-update).

Repair uses the same embedded loop as `openclaw triage --run`, without a terminal
or an external coding-agent CLI. It uses the system-agent owner's default model,
its `model.fallbacks`, then other configured agents' authenticated routes,
skipping models without tool support and routes without usable authentication.
It reports unavailable inference instead of waiting for a login or approval
prompt. Operator-owned updates and explicit repair requests
replace interactive exec approval with a prompt-free run scoped to the installation
or staged candidate root (`fs.workspaceOnly: true`), preserving safe-bin and tool
allowlists and refusing explicit exec or repair-tool denies with `exec-denied-by-policy`
and an `openclaw triage` external handoff.

Chat-requested updates recheck the requester's command ownership before repair
effects and service activation. If configuration or plugin loading fails, the
update stops and records the load error. Fix that error before retrying; only a
successful policy check can report that the requester is no longer an owner.

The default limits are three turns, ten minutes total, five minutes per turn,
and 40 tool calls per turn. The updater supplies a validation check before the
first turn and after each attempt. Repair stops when validation succeeds, a
budget is reached, or a turn fails to improve the result; a regression is
reported as unrepaired. The model's `REPAIR_RESULT` summary does not replace
these checks.

The agent may diagnose and repair the target install or staged candidate and
its OpenClaw state, including running Doctor lint, `doctor --fix`, and health
checks. Its repair contract forbids changing credentials or auth stores,
deleting state or databases, package-manager writes outside the target root,
and service or Gateway lifecycle commands. The orchestrator retains control of
activation, restart, and rollback. The repair loop does not take snapshots or undo
changes. Attempts appear live in the Control UI's phase and step details and in
`openclaw update status`; the final report includes their summaries. JSON run
records retain the `repair` attempt list. Repairing stays hidden in the Control
UI when the run never entered that phase.

For an explicit repair using configured inference, run `openclaw triage --run`
in a terminal on the Gateway host. Interactive triage checks Doctor lint, runs
up to one embedded repair turn with time and tool-call limits, and checks Doctor
again. See [Triage](/cli/triage#installation-target-and-embedded-handoff) for the
repair contract, installation targeting, and validation results.
