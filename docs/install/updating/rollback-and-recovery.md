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

### Automatic schema-neutral rollback

If a newly activated package fails verification, `openclaw update` compares the
shared and affected per-agent SQLite `user_version` values with their
pre-activation values and checks that the config file still matches the content
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
ends failed.

If the config file changed after the activation Doctor pass or the databases are
not schema-neutral, rollback is refused with
`state-migrated-no-rollback`. For config edits, the next action names the file
whose changes blocked restoration. The updater attempts
[bounded unattended repair](/install/updating#unattended-repair-on-your-own-inference)
on the installed candidate, preserving migrated state. The same repair slot can
run if rollback itself fails, targeting the previous release if its package was
already restored. If repair cannot pass verification, the update
fails with the original reason and recorded repair attempts. Use `openclaw triage`
or the printed repair command before considering an older version.
Automatic rollback restores code and the captured config, not a full state snapshot.
The candidate's temporary migration-rehearsal snapshots are removed after
validation and do not replace your backup.
If the schema comparison cannot be completed, automatic rollback is refused
(`rollback-state-unverified`). The freshly installed candidate owns final
verification and reporting after migration,
preserving the same run ID and recorded activation steps.

For pnpm and Bun, changes to sibling global packages after staging refuse automatic rollback (`rollback-project-changed`) without restoring the shared project; keep a reachable candidate installed, otherwise keep the Gateway stopped and follow the report’s repair command.
A refusal before the live swap restarts the unchanged Gateway and preserves the sibling changes.

### Before updating: create a verified backup

`openclaw update` preserves an automatic pre-update config copy, but it does not
create a full state recovery point. Before a significant update, create one
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

Failed interactive updates open triage automatically after updater cleanup and
pass the captured failure to the agent before fresh diagnostics can delay the
handoff. JSON, `--yes`, and non-interactive update invocations collect diagnostics
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
and config edits after the activation Doctor pass or a schema migration prevent rollback, or
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
