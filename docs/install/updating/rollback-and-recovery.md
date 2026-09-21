---
summary: "Downgrading, automatic schema-neutral rollback, verified pre-update backups, and triage when an update leaves you stuck"
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
runs required Doctor migrations, and verifies the activated Gateway. A raw
`npm i -g` replacement does not retain the previous package or run this recovery
workflow; use `openclaw update` or [create a backup first](#before-updating-create-a-verified-backup).

The updater retains the previous package during activation and keeps it when
failed recovery cannot prove a working installation. Migration recovery originals
remain until explicit [update cleanup](/cli/update#update-cleanup). These are
separate recovery mechanisms: cleanup does not manage package or Git runtime
backups, and retained migration originals are not a full pre-update backup.
Preserve every recovery location named in the update report until you have
verified the installation.

Launcher backups compare the link type and target, plus ownership when it can
be preserved. Symlink permission bits do not block an update; macOS link modes
are copied when supported. Regular-file launchers still require matching modes
and contents. If backup verification fails, the report names the differing
fields and the retained failed copy for inspection before retrying.

This behavior belongs to the installed updater. An older updater, including
2026.9.4, can refuse a macOS launcher backup before the target version runs.
Use the installation's [manual package-manager update procedure](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
if that first update is blocked.

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
- `openclaw.json`, including `meta.lastTouchedVersion`.
- `state/openclaw.sqlite` and every `agents/<id>/agent/openclaw-agent.sqlite`,
  including databases at configured paths outside the default layout.
- The workspaces, credentials, and retained originals needed by that installation.

Use `openclaw backup create --verify` for a verified, WAL-aware archive. Never copy only the
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

`openclaw update` does not create or replay a full-state checkpoint. It can
restore a retained package only under the compatibility checks below. It cannot
reverse a database migration by replacing the package. Use a verified pre-update
backup with its matching release when migration has made state incompatible.

An existing pending checkpoint-recovery record blocks further mutable updates.
The updater reports that it is unsupported and leaves its records, backups, and
state unchanged. Do not remove or alter retained artifacts to force a clean
status, and do not use `update finalize` to bypass the refusal. Preserve the
reported locations for a compatible recovery implementation or an independent
verified backup. An interrupted or refused restore is not a successful rollback.

### Automatic schema-neutral rollback

If a newly activated package fails verification, `openclaw update` compares the
shared and affected per-agent SQLite `user_version` values with their
pre-activation values and checks that the config file still matches the content
reported by the new version’s activation Doctor writer.
Databases first created during activation or verification are
schema-neutral when their version matches the new version's supported version for
that database kind. A changed schema version or missing pre-existing database,
or a new database at a foreign version, still blocks rollback. Before restoring
code, the updater also checks that the previous package supports any new database;
unknown or incompatible support refuses rollback with `rollback-state-unverified`.
When both checks pass and the retained previous package was verified before the
update, it stops the new version and restores the previous generation: package,
command shim, service definition, and exact pre-activation config bytes, including
the previous writer stamp. Config replacements use owner-only permissions (`0600`);
unchanged config needs no write. Owned, writable
service metadata is refreshed; protected service definitions are preserved.
The CLI verifies the restarted previous Gateway's service health, version/build
identity, plugins, channels, and `/readyz` again. Update verification does not use
model inference: the managed service must be running and own its port, and the
Gateway hello handshake must match the expected artifact.

The new version’s Doctor migrations in the main config file do not block rollback, including on
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
rejected version into a successful update.

Recovery reports distinguish restored package files from a healthy Gateway.
A verified rollback names the version serving after recovery, including when
an additional repair was needed. If the restored service fails its health check,
the result records `recovery.service: "failed"`; the report says health failed
and includes the recorded recovery reason. Health is reported as unverified only
when verification could not run or complete, such as a readiness timeout. Both
outcomes direct you to `openclaw gateway status --deep` to check the serving version
and readiness. Rollback uses the same startup allowance as the update's activation check.
Restart notifications retain the recovery fields understood by the restored runtime.
Detailed recovery reasons remain in the update result, status diagnostics, and failure report.

Use `openclaw update status` for the recorded reason and `openclaw triage` to
diagnose a failed check. Recovery guidance reports whether the Gateway is running
or stopped from the latest service observation, even when the new version is running but did
not pass verification. A restored Gateway must pass its own verification checks
before the run can finish as `rolled-back`.
Automatic triage never follows a verified rollback; it runs only when the update
ends failed. In an interactive terminal, you can choose **Diagnose update failure**,
**Report update failure**, or **Exit**, which is selected by default. Reporting
shows the sanitized preview and requires separate confirmation before issue
creation. Skipping or cancelling does not start diagnosis or submit a report.
JSON, `--yes`, non-interactive, and managed-service handoff invocations do not
show this menu after rollback.

If the config file changed after the activation Doctor pass or the databases are
not schema-neutral, rollback is refused with
`state-migrated-no-rollback`. For config edits, the next action names the file
whose changes blocked restoration. The updater preserves the failed outcome and migrated state. Optional
[post-failure triage](/install/updating#unattended-repair-on-your-own-inference)
can run after update ownership and service compensation settle, including after
failed rollback. Use the printed diagnostics and installation-specific repair
command before considering an older version. Triage does not rewrite that
failed update as successful.
Automatic rollback restores code and the captured config, not a full state snapshot.
The temporary snapshots used to check migrations are removed after
validation and do not replace your backup.
If the schema comparison cannot be completed, automatic rollback is refused
(`rollback-state-unverified`). The newly installed version owns final
verification and reporting after migration,
preserving the same run ID and recorded activation steps.

For pnpm and Bun, changes to sibling global packages after staging refuse automatic rollback (`rollback-project-changed`) without restoring the shared project; keep a reachable version installed, otherwise keep the Gateway stopped and follow the report’s repair command.
A refusal before the live swap restarts the unchanged Gateway and preserves the sibling changes.

### Before updating: create a verified backup

`openclaw update` preserves an automatic pre-update config copy, not a full-state
recovery point. Before a significant update, create an independent verified backup
explicitly:

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
and use of your own account/tokens. Only an affirmative Yes proceeds. Enter, `n`,
cancellation, or 30 seconds without an answer skips the launch, prints a manual
recovery command, and preserves diagnostics and the failed update's exit status.
Explicit `openclaw triage` does not ask for this confirmation.
JSON, `--yes`, and non-interactive update invocations can start one owned automatic
repair after an eligible failure; other failures retain diagnostics and handoff
commands. For diagnostic collection
alone, use `openclaw triage --non-interactive`; add `--update-result <path>` to
include a saved update-failure artifact. See [Triage](/cli/triage) for command
formatting and installation targeting.

Triage keeps the failed update's report intact. An update started during repair
creates its own history entry. After package replacement, restart commands run
from the updated installation. A restart accepted by the service owner can still
fail readiness checks; inspect `openclaw gateway status --deep` before retrying.

Keep a stopped, unverified Gateway stopped and preserve migrated state during
repair. A reachable version retained after a schema migration can continue
serving while you diagnose it.
The failed update retains its nonzero exit code even if the agent repairs it.

- For `openclaw update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

### Unattended repair on your own inference

Updates, validation, verification, and rollback do not require inference or model
authentication. An unavailable model route cannot block those operations.
Validation failures discard the staged candidate while the old Gateway keeps
serving. After activation, the updater first completes its existing
compatibility-checked rollback and service-compensation flow.

Eligible failed updates can then start one owned triage repair after their update
ownership has been released. Triage targets the installation that remains,
preserves migrated state, and keeps the original failed update's outcome and
nonzero exit code. Successful repair does not retrospectively publish a successful
update or verified rollback. Reports from older updaters can still contain a
`repairing` phase and its attempt summaries.

Published 2026.9.4 updaters may invoke the candidate's repair-worker entry before
the update settles. New candidates retain its response protocol but report
inference repair unavailable without loading a model or changing operator state.
The published driver still owns that first update's control flow and budgets.

For an explicit repair using configured inference, run `openclaw triage --run`
in a terminal on the Gateway host. Triage runs Doctor health checks, attempts
up to one embedded repair turn with time and tool-call limits, and runs Doctor
again. It uses the normal runtime credential resolver, including inherited
profiles and OAuth refresh; unavailable inference produces an external handoff
rather than a login prompt. The repair keeps the existing installation scope and
tool-policy restrictions.

A saved activation or recovery failure additionally requires recorded updater
completion and current installation and Gateway verification. An attributed
Doctor/config blocker can be resolved by fresh Doctor checks and the recorded
installed identity, while its historical failed run remains unchanged. Native
service activation and recovery retain their existing authority checks. See
[Triage](/cli/triage#installation-target-and-embedded-handoff) for installation
targeting, repair limits, and validation results.
