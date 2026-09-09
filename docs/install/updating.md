---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
---

Keep OpenClaw up to date.

For Docker, Podman, and Kubernetes image replacements, see
[Upgrading container images](/install/docker#upgrading-container-images). The
gateway runs startup-safe upgrade work before readiness and exits if mounted
state needs manual repair.

Before a significant update, [create a verified backup](#before-updating-create-a-verified-backup).
Automatic config copies and migration recovery originals are not a full-state
backup.

## Recommended: `openclaw update`

Detects your install type (npm, pnpm, Bun, or git), validates the candidate while
the old Gateway serves, then activates and verifies the update.

```bash
openclaw update
```

An already-installed package version or Git target SHA finishes as
`skipped` / `already-current` without stopping or restarting the Gateway.
An explicit `--channel` choice still becomes the saved update channel.
For targets that support candidate validation, Doctor lint, config and plugin planning, and a
canary boot on copied state finish before the service stops. The first activation
window contains the swap, required migrations, and service start. Plugin packages
download and sync while the core Gateway serves. A changed plugin snapshot then
requires a second measured activation window for full Doctor migrations under
exclusive maintenance, restart, and verification. Unchanged plugins do not run
another full Doctor pass. The final report records downtime and verification
results. See
[Validation and activation](/cli/update#validation-and-activation) for the checks.

Package updates also check npm availability for enabled configured plugins before
stopping the serving Gateway or replacing the installed core. Registry targets
are checked early; explicit package artifacts are checked using the privately
staged package version before rehearsal, live-state preparation, or activation.
The check uses the same plugin version rules as post-update synchronization, including release-cohort
tracking, beta selection, and extended-stable targets. A missing version or registry
error refuses the update with `plugin-target-unavailable`; registry-target
`--dry-run` reports the same refusal. For explicit artifacts, `--dry-run` does not
stage the package and reports that plugin availability checking remains pending.
Retry when the registry or mirror is ready, select an older available
core with `openclaw update --tag <version>`, or disable the affected plugin before
retrying. Extended-stable does not accept `--tag`; retry later or explicitly switch
channels. Bundled and path-installed plugins do not require registry requests.
This metadata check does not reserve downloads, so later download failures can
still require recovery.

Switch channels or target a specific version:

```bash
openclaw update --channel beta
openclaw update --channel extended-stable
openclaw update --channel dev
openclaw update --dry-run   # preview without applying
```

`openclaw update` has no `--verbose` flag (the installer does). For diagnostics use
`--dry-run` to preview planned actions, `--json` for structured results, or
`openclaw update status --json` to inspect channel and availability state.

`--channel beta` selects the newest version by semantic version order from the
beta and latest npm dist-tags. Use `--tag beta` for a one-off package update pinned to the raw npm
beta dist-tag instead.

A saved `update.channel` remains the channel for future updates, automatic
checks, and update status. For example, a one-off beta package on a saved stable
channel keeps checking stable afterward. Use `--channel beta` to subscribe to
beta updates. Plugins still follow the installed core version where required
for compatibility.

`--channel extended-stable` is package-only, and installation remains
foreground-only. OpenClaw reads the public npm `extended-stable` selector,
verifies the selected exact package, and installs that exact version. Missing
or inconsistent registry data fails closed; it never falls back to `latest`.
If the selected version is older than the installed version, the normal
downgrade confirmation still applies. The CLI persists the channel after a
successful core update; a direct
`npm install -g openclaw@extended-stable --allow-scripts=openclaw` does not
update `update.channel`, but a final extended-stable package version still
checks only the verified `extended-stable` selector for update availability.
That direct command is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.
After the core swap, eligible official npm and trusted official ClawHub plugins with bare/default or
`latest` intent converge to that exact core version. Exact pins and explicit
non-`latest` tags, third-party plugins, custom registries, and other sources remain unchanged.
Version-bound runtime plugins converge to the base release cohort when the
core is a correction release (for example, `YYYY.M.P-2` uses plugin
`YYYY.M.P`).
Catalog installs created by current OpenClaw versions retain that default
intent. Older records that contain only an exact version remain pinned because
OpenClaw cannot safely distinguish an old automatic pin from a user pin. For npm
installs, run `openclaw plugins update @openclaw/name` once on the extended-stable
channel to opt that plugin back into exact-core tracking.

`--channel dev` gives a persistent moving GitHub `main` checkout for npm-owned
package installs and existing Git checkouts. Package
installs reject the `--tag main` shorthand because the workspace checkout is
not a self-contained package artifact. Use `openclaw update --channel dev` to
switch to the supported checkout and build flow. Other explicit package specs
keep their package-manager behavior.

Managed npm plugins on the beta channel use the same newest-of-beta/latest
selection, including official plugins such as `@openclaw/codex`. An older beta
tag cannot hold a plugin behind the current stable release. Startup repair
leaves already-current packages in place so a no-op refresh does not require
another restart.

See [Release channels](/install/development-channels) for channel semantics.

### Updating from 2026.9.2 across a schema bump

Updates driven by OpenClaw 2026.9.2 can cross a shared-state schema bump normally.
The target applies the migration content while retaining the old published
schema version, so the old updater can finish its ledger writes and final
report. Doctor explains that schema content is applied and version publication
is deferred. The new Gateway runs on the migrated content during this interval.

Publication waits until every affected update run has been terminal for at least
five minutes. A running row that has not changed for more than 30 minutes counts
as abandoned for publication purposes only; this does not terminalize an
identityless update-history row. The Gateway watcher publishes after the deadline;
a later database open can also publish it. See the precise timing and residual
old-CLI limitation in [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters).

If an agent database also needs migration, required state metadata is missing,
or the state-content migration fails, Doctor instead reports
`update-schema-bump-unfenced` with database versions and manual update commands.
Let the failed update finish restoring the previous package. OpenClaw 2026.9.2
leaves the Gateway service stopped after failed post-install verification. Run
the manual update from a shell outside the Gateway, replacing `<target>` with
the exact target version from the refusal:

```bash
openclaw gateway stop
npm install -g openclaw@<target> --allow-scripts=openclaw
openclaw doctor --fix
openclaw gateway start
```

Run each command only after the previous one succeeds. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`. For a pnpm-owned install, replace the install
command with `pnpm add -g --allow-build=openclaw openclaw@<target>`; for Bun, use
`bun add -g --trust openclaw@<target>`.

Same-schema updates, earlier ledger-less updaters such as 2026.9.1, and fenced
transactional updaters from 2026.9.3 onward keep their existing behavior. The
fallback does not undo an earlier migration; if the database is already newer
than the restored package, install a compatible target and finish Doctor before
starting the Gateway.

### From chat

The OpenClaw owner can say "update" (the agent uses the `gateway` action
`update.run`) or send `/update`. The candidate validates while the old Gateway
serves, and an already-current update does not restart it. Update runs can send
these notices in that chat as the Gateway observes the recorded milestones:

1. An acknowledgement when the update is accepted.
2. `⏳ Restarting the gateway now (v<from> → v<to>)…` when activation is recorded before the Gateway stops.
3. `🔁 Back on v<to>, verifying…` when the new Gateway starts verification.
4. The final report, including successful updates.

Managed systemd or launchd updates can stop the Gateway before an intermediate
notice is delivered. The complete four-message sequence is not guaranteed for
those installations; the durable run report remains available after reconnect.

Runs with an internal origin session, including Control UI and webchat, receive
these notices directly in that session's transcript. Passing only `sessionKey`
is enough; the caller does not need to supply `deliveryContext`.
Before stopping the managed service, the updater waits for the serving Gateway
to finish its restart notice attempt. That wait is capped at 10 seconds so a
stalled notice cannot block activation.

The report includes the outcome, recorded phase durations, failed steps,
verification facts, and the next action when needed. A run sends each notice
at most once; an update that stops before restart sends only the notices for
phases it reached. If the update cannot start, the bot records and explains why
and provides the manual command when available.

Chat, CLI, Control UI, and automatic updates share a durable run ID. Use
`openclaw update status` to read the active or latest report, including after a
restart; `--json` exposes the `activeRun` and `lastRun` records. See
[Run history and reports](/cli/update#run-history-and-reports) for Gateway history
queries.

The sender must be in [`commands.ownerAllowFrom`](/tools/slash-commands#configuration).
`/update` also requires `commands.restart` (enabled by default).
Agents must never run `npm install -g openclaw` or stop the Gateway service
from a chat shell; use the update action so restart and notification stay coordinated.

## Stale update history

If update status stays in progress while the Gateway is healthy, check that no
update is still running. On the updated installation, run:

```bash
openclaw update repair
openclaw update status
```

For an inactive legacy row older than 30 minutes, repair verifies that the
running Gateway matches the installed version and build, then clears the stale
run without maintenance or a service restart. A new explicit `openclaw update`
can also supersede a single stale identityless row. Recent rows and recorded
live drivers are protected. Identityless rows are never cleared automatically;
the Control UI's configuration-write suspension clears after reconciliation.

OpenClaw 2026.9.2 does not reject a new CLI update because an older running row
exists: its [admission path](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command-run.ts#L77)
creates a new run, and its [ledger](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/infra/update-run-ledger.ts#L250)
checks only for a duplicate run ID. Upgrade normally, then use the updated
`openclaw update repair` if the old history remains. A package-manager escape
is not required for this ledger defect. See [Update run history](/cli/update#run-history-and-reports).

## Retire update recovery data

Once you have verified the update and your conversations, preview retained
migration originals:

```bash
openclaw update cleanup --dry-run
```

Use the same profile and state/config overrides as the update, and check the
state directory printed in the report. The metadata-only preview can run while
the Gateway is active. To apply, stop that Gateway yourself, wait for other
SQLite maintenance to finish, and stop database readers such as session-listing
watchers. Keep them stopped until `openclaw update cleanup` exits; read-only
connections can change WAL/SHM sidecars and invalidate verification. Cleanup never
stops or restarts the Gateway. Confirmation defaults to **No**; automation must
explicitly pass `--yes`, including when using `--json`.

Cleanup permanently gives up rollback to eligible originals, including repaired
branches and old provider metadata. Current SQLite history, operator backups,
and protected or unknown artifacts remain. It is not a substitute for a
[pre-update backup](#before-updating-create-a-verified-backup). See
[Update cleanup](/cli/update#update-cleanup) for eligibility, JSON output, and
resuming interrupted deletion.
Private package, command-shim, and Git runtime backups remain owned by the update
transaction and are outside this migration cleanup. An interrupted entry in update
history does not block cleanup of otherwise eligible migration archives.

## After updating

Successful managed `openclaw update` runs already restart and verify the Gateway.
Use these steps after a manual installation or when checking a reported problem.

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Doctor also compares active official plugins with the OpenClaw package the managed service will load after restart. Resolve any plugin restart-readiness warning before continuing. Details: [Doctor](/gateway/doctor)

If you use the unpacked Chrome extension, also run `openclaw browser doctor --browser-profile chrome`.
For a version-mismatch warning, reload the extension from `chrome://extensions`;
fully restart Chrome if the warning remains.

### Restart the gateway

```bash
openclaw gateway restart
```

### Verify

```bash
openclaw health
```

</Steps>

<a id="rollback" />
<a id="roll-back-a-package-install" />
<a id="roll-back-a-source-checkout" />
<a id="downgrading-across-the-session-sqlite-migration" />
<a id="restore-state-only-when-necessary" />
<a id="verify-the-rollback" />

## Detailed topics

<CardGroup cols={3}>
  <Card title="Other update methods" href="/install/updating/update-methods" icon="shuffle">
    Switching between npm and git installs, source servers, the installer, and manual package managers.
  </Card>
  <Card title="Automatic updates" href="/install/updating/automatic-updates" icon="clock">
    The auto-updater, per-channel behavior, and update campaigns.
  </Card>
  <Card title="Rollback and recovery" href="/install/updating/rollback-and-recovery" icon="rotate-left">
    Downgrades, automatic rollback, pre-update backups, and triage.
  </Card>
</CardGroup>

- <a id="switch-between-npm-and-git-installs" />[Switch between npm and git installs](/install/updating/update-methods#switch-between-npm-and-git-installs)
- <a id="source-checkout-servers-(reference-script)" /><a id="source-checkout-servers-reference-script" />[Source-checkout servers (reference script)](/install/updating/update-methods#source-checkout-servers-reference-script)
- <a id="alternative%3A-re-run-the-installer" /><a id="alternative-re-run-the-installer" />[Alternative: re-run the installer](/install/updating/update-methods#alternative-re-run-the-installer)
- <a id="alternative%3A-manual-npm%2C-pnpm%2C-or-bun" /><a id="alternative-manual-npm-pnpm-or-bun" />[Alternative: manual npm, pnpm, or bun](/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun)
  - <a id="package-lifecycle-and-operator-state" />[Package lifecycle and operator state](/install/updating/update-methods#package-lifecycle-and-operator-state)
  - <a id="advanced-npm-install-topics" />[Advanced npm install topics](/install/updating/update-methods#advanced-npm-install-topics)
    - <a id="read-only-package-tree" />[Read-only package tree](/install/updating/update-methods#read-only-package-tree)
    - <a id="hardened-systemd-units" />[Hardened systemd units](/install/updating/update-methods#hardened-systemd-units)
    - <a id="disk-space-preflight" />[Disk-space preflight](/install/updating/update-methods#disk-space-preflight)
- <a id="auto-updater" />[Auto-updater](/install/updating/automatic-updates#auto-updater)
  - <a id="update-campaigns" />[Update campaigns](/install/updating/automatic-updates#update-campaigns)
- <a id="downgrade" />[Downgrade](/install/updating/rollback-and-recovery#downgrade)
  - <a id="automatic-schema-neutral-rollback" />[Automatic schema-neutral rollback](/install/updating/rollback-and-recovery#automatic-schema-neutral-rollback)
  - <a id="before-updating%3A-create-a-verified-backup" /><a id="before-updating-create-a-verified-backup" />[Before updating: create a verified backup](/install/updating/rollback-and-recovery#before-updating-create-a-verified-backup)
- <a id="if-you-are-stuck" />[If you are stuck](/install/updating/rollback-and-recovery#if-you-are-stuck)
  - <a id="unattended-repair-on-your-own-inference" />[Unattended repair on your own inference](/install/updating/rollback-and-recovery#unattended-repair-on-your-own-inference)

## Related

- [Install overview](/install): all installation methods.
- [Doctor](/gateway/doctor): health checks after updates.
- [Migrating](/install/migrating): major version migration guides.
