---
doc-schema-version: 1
title: "Side-by-side update design"
summary: "Design proposal and migration map: one release layout, one launcher, one update driver, and copy-and-swap state for every installation kind"
read_when:
  - Deciding how OpenClaw replaces its code and upgrades its state during an update
  - Reviewing which parts of the current updater are deleted and what replaces them
  - Planning the migration of existing installations to the release layout
---

# Side-by-side update design

**Design proposal. Nothing on this page is built by this page. The decisions under
[Decisions needed](#decisions-needed) are open.** It was read against `main` at
`0abe03d10082` on November 20, 2026.

An update must be transactional (it succeeds, or the previous installation keeps
running untouched), reliable, fast, and cheap in disk space. The route here is to
finish what three merged changes started, make their model the only one, and
delete what they replace.

## Summary

1. **Code is side by side.** Every release is a directory that is written once.
   One link names the selected release. Activation and code rollback are one
   rename of that link.
2. **State is copied, migrated, and swapped by the Gateway that will use it.**
   The new release's Gateway start copies the databases that need a migration,
   migrates the copy, and renames it into place. The replaced files stay beside
   it until the release has proven itself.
3. **A frozen launcher is the only recovery owner.** The service starts the
   launcher. A release that fails to start twice is switched back and its
   replaced state files are renamed back. A release that becomes ready settles
   its own trial. No recovery step depends on the updater process surviving.
4. **One driver.** `openclaw update` stages a release, switches the link, asks the
   Gateway to restart, and reports what the launcher and the Gateway decided. It
   takes no state lock, copies no state, runs no Doctor, and stops no service.
   The CLI, the Control UI, automatic updates, and the Gateway tool all run it.

Each of the three pieces exists on `main` for part of the installed base. The work
is to extend them to the rest, then remove the in-place paths.

## What main already has

The premise that an update rehearses on a private copy and then migrates in
place describes updaters released before November 2026. `main` has moved:

| Piece                                               | State on `main`                                                                                                                                                            | Source                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Release directories behind a linked package root    | Built for the `install-cli.sh` prefix and the durable service copy, POSIX only ([#198835](https://github.com/openclaw/openclaw/pull/198835)).                              | `src/infra/package-release-slot*.ts`, `package-update-release-switch.ts` |
| Git checkouts served from release worktrees         | Built for POSIX checkouts whose Gateway service owns the install ([#199706](https://github.com/openclaw/openclaw/pull/199706)). The developer's checkout is never written. | `src/infra/git-release*.ts`, `update-runner-git-release.ts`              |
| Frozen launcher with a two-start trial and rollback | Built for Git releases only.                                                                                                                                               | `src/infra/git-release-launcher.ts`                                      |
| Copy-and-swap state upgrade at Gateway start        | Built for SQLite state. The Gateway start is its only owner.                                                                                                               | `src/state/state-upgrade*.ts`, `sqlite-copy-swap.ts`                     |
| Design record for the linked root                   | Open as [#197949](https://github.com/openclaw/openclaw/pull/197949) (`update-generations-design`). Eight decisions accepted by a maintainer.                               | That pull request                                                        |

The Git release path already skips the updater's runtime copy, the pack
transfer, the managed-service stop and park, the database rollback capture, and
per-update service regeneration. Its measured outage is 8 to 10 seconds
(#199706, macOS, launchd). It is the model this page generalizes.

Everything else still runs beside it. The update code is 112,138 non-test lines
in 503 files (`src/cli/update-cli`, `src/infra/update-*`, `package-update-*`,
`package-release-*`, `git-release*`), with 193,316 lines of tests. The release
layout itself is 2,456 of those lines. Each merged slice added a path and kept
the old one as a fallback: #199706 was a net 980 production lines added.

This page differs from #197949 in three ways. It makes the release layout the
only layout instead of an optimization with a fallback. It moves the trial
launcher from Git installs to every install. It removes the installed updater's
state work instead of moving it to the candidate in stages. Where the two pages
conflict, see [decision 1](#decisions-needed).

## Layout

One layout, two roots. The names are the ones `main` already writes, so no
installation converted since #198835 moves again.

```text
<prefix>/                         one per installation; owned by the service account
  openclaw-launcher.mjs           frozen; the service definition names this file
  <slot> -> releases/<id>/<slot>  the release link; the only record of what is selected
  releases/
    <id>/                         written once, then read-only by convention
    .trial                        present only while a release is on trial
    .leases/<id>/<pid>-...        one per running Gateway

<state dir>/                      unchanged; never inside a release
  .upgrade-<build>-<pid>-<time>/  private copy while a migration runs; removed after
  .upgraded-<build>.json          the applied swap plan of the last migration
  **/<file>.pre-<build>           files the last migration replaced
```

`<slot>` is `lib/node_modules/openclaw` in an npm prefix and `openclaw` in a
Git prefix (Node refuses to strip types under `node_modules`).

| Installation kind                                    | Prefix                           | Release contents                                         | Pointer switch                                                                                                                | On `main` today                 |
| ---------------------------------------------------- | -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `install-cli.sh`                                     | `<PREFIX>/tools/node-v<version>` | Private npm prefix                                       | Rename a temporary symlink over the slot                                                                                      | Release layout, no launcher     |
| Durable service copy (npx and other one-off runners) | `<state dir>/npm`                | Private npm prefix                                       | Same                                                                                                                          | Release layout, no launcher     |
| Git checkout with a Gateway service, POSIX           | `<state dir>/git-install`        | `git worktree add --detach` of the checkout, built there | Same                                                                                                                          | Release layout with launcher    |
| Git checkout run by hand (no service)                | None                             | The checkout                                             | None: pull and build, by the developer or by `openclaw update`                                                                | In-place runner                 |
| `install.sh` default: an npm prefix the user manages | The npm prefix                   | Private npm prefix                                       | Same symlink rename. `npm install -g` by hand turns the link back into a directory, and the next update adopts it again       | In-place swap with a journal    |
| pnpm, Bun, Homebrew, Nix, system packages            | Manager-owned                    | Manager-owned                                            | The manager's own command                                                                                                     | In-place swap, or refused       |
| Windows (npm, Git)                                   | Same as POSIX                    | Same                                                     | A directory junction, replaced by two renames through `.previous` as `activateRuntime` in `node-host-launcher.mjs` does today | In-place swap                   |
| Docker, Kubernetes                                   | The image                        | The image                                                | The orchestrator starts the new image on the same state volume                                                                | Entrypoint runs Doctor in place |
| macOS app                                            | `<state dir>/runtime`            | App-seeded build directories                             | The app's `current` and `previous` links                                                                                      | `openclaw update` refuses       |
| Immutable installation (Team)                        | Root-owned                       | Source build keyed by commit                             | Journaled `current` rename                                                                                                    | Its own owner, 4,660 lines      |

Rules that hold on every row:

- **Live state is never inside a release**, and a release never holds state.
  Recovery data lives in the state directory, beside what it recovers. Nothing
  is keyed by the install path, so moving an installation strands nothing.
- **A release is never written after it is selected.** Collection removes a
  release only when the link does not name it, no lease or trial names it, and
  it is a day old (the rule #197949 accepted).
- **The developer's checkout is never a release.** A Git install serves from
  worktrees of it. A checkout run by hand is not an installation and is updated
  by pulling and building. It gets no transaction, by choice.
- **Containers and the macOS app use only the state half.** Their host already
  keeps code side by side. They gain the Gateway-start state upgrade and lose
  the entrypoint Doctor pass.
- **Package-manager-owned installations** are [decision 3](#decisions-needed).

## The update, step by step

| Step                                                                                                                                | Runs in                                              | Old Gateway                     | Fails or crashes here                                                               | Left on disk                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| 1. Resolve the target (channel, tag, commit)                                                                                        | Driver                                               | Serving                         | Nothing changed                                                                     | Nothing                                |
| 2. Admit: free space for one release, Node floor, one update at a time (a lock file in `releases/`)                                 | Driver                                               | Serving                         | Nothing changed                                                                     | Nothing                                |
| 3. Stage `releases/<id>`: package install with integrity check, or worktree plus build                                              | Driver                                               | Serving                         | Old release keeps serving                                                           | An unselected release, later collected |
| 4. Verify: run the release's `--version` and contract check with the service's Node                                                 | Driver                                               | Serving                         | Old release keeps serving                                                           | Same                                   |
| 5. Write `.trial` (target, previous, build), then rename the link                                                                   | Driver                                               | Serving, from its own real path | Before the rename: old link. After: new link with a trial                           | A trial record                         |
| 6. Ask the Gateway to drain and restart                                                                                             | Driver to Gateway                                    | Draining                        | The link has moved, so the next start by anyone runs the trial                      | Same                                   |
| 7. Start                                                                                                                            | Launcher                                             | **Down**                        | Counted. A second failed start goes to step 9                                       | An attempt count                       |
| 8. Upgrade state when a database is older than the build: copy, migrate the copy, validate, write the plan, rename                  | New Gateway, under the Gateway lock                  | **Down**                        | Before the plan is durable: live state untouched. After: the next start finishes it | `.upgrade-*` or `.pre-<build>` files   |
| 9. Ready: delete `.trial`. Or two failed starts: rename `.pre-<build>` files back, remove what the plan added, rename the link back | New Gateway, or launcher                             | Up again                        | Both are reruns of the same idempotent step                                         | Nothing, or the old release serving    |
| 10. Report, converge plugins, collect releases, settle owed steps                                                                   | New Gateway once ready; a terminal driver reports it | Serving                         | Recorded as owed. Never undoes the update                                           | The run record                         |

**Commit points.** There are two, both one rename, both owned by the code that
performs them. The link rename (step 5) commits the code. The plan file (step 8)
commits the state. Neither is final until the trial settles (step 9), which is
the point of no return for the run: after it, the previous release is no longer
a fallback and is only kept until collection.

**Downtime** is steps 7 to 9: start, plus copy and migration when a schema
changed. A release with unchanged schemas copies nothing.

**One recovery rule.** At every service start the launcher reads the link and
the trial. No trial: start what the link names. A trial for another target:
delete it. A trial with fewer than two attempts: count and start. A trial with
two attempts: restore and switch back, then start. Every branch is safe to
repeat after a crash, and it is the only code that runs before a release loads.
The driver adds nothing to recovery: if it dies after step 5, the Gateway's own
restart check sees the link move, and the Gateway or the launcher settles the
trial without it.

**Entry points.** The driver never stops the service. Started from a terminal
it outlives the restart, waits for the trial to settle, and reports. Started by
the Gateway (Control UI, automatic updates, the Gateway tool) it is a child in
the service's control group, and the managed systemd unit uses
`KillMode=mixed`, so the restart ends it. That is why step 10 belongs to the
new Gateway and not to the driver: before it asks for the restart, the driver
writes the run record with the target and what is still owed, and the new
Gateway finishes that record when it becomes ready. The managed-service handoff
exists because the current updater must stop the service and survive it, which
takes a transient unit outside the Gateway's control group. With nothing left
for the driver to do after the restart, it has no job here.

**Accepted edge cases.**

- Writes made during a failed trial are lost with it (accepted in #199706).
- A release that starts, becomes ready, and then misbehaves is not rolled back
  automatically. Ready is the bar.
- A manual start on a path that bypasses the launcher gets no trial. Only the
  service start is protected.
- Two starts fail for a reason unrelated to the release, such as a port in use:
  the release is switched back and the update reports failed. The next update
  tries again.

## State copy

**Owner.** `upgradeStateDirectory` in `src/state/state-upgrade.ts`, called from
Gateway start before any reader opens state. It is the single owner on every
installation kind, including containers and the macOS app.

**Writers are excluded** by the Gateway lock, taken with file-only access. The
old Gateway has exited before the new one starts, so the copy is taken with no
writer and needs no second pass. This is why the copy sits in downtime: a copy
taken while the old Gateway serves cannot be adopted.

**What is copied.** Once any database is older than the build: the shared
database, always, whatever its size or version; each outdated agent database;
other SQLite files up to 64 MiB including their WAL and journal; and every
other file in the state directory that is not excluded, which covers the
config, credentials, identity, devices, and the JSON stores Doctor migrates.
Excluded: workspaces, managed worktrees, media payloads, Knowledge stores,
browser profiles, backups, caches, locks, temporary files, and `git-install`.

**Where.** `<state dir>/.upgrade-<build>-<pid>-<time>/`, so the swap is a rename
on one filesystem. A config file outside the state directory is staged beside
itself for the same reason.

**Verification.** Schema version, `integrity_check`, `foreign_key_check`, and
per-table row conservation on the copy, then config admission by the build that
will read it. A refused config publishes nothing.

**The switch** is a durable plan followed by renames. Each replaced file becomes
`<file>.pre-<build>`. A crash after the plan is finished by the next start. A
failed trial renames the files back.

**Disk.** Peak is everything in the copy scope above twice (on the host that
motivated this work, the shared database plus a 9 GiB agent database), plus an equal scratch margin of
at least 256 MiB, checked before the copy with exact byte counts in the refusal.
A refusal changes nothing, and the launcher's second failed start switches back
to the old release. Steady state today is also twice, because one `.pre-`
generation is kept until the next upgrade. [Decision 4](#decisions-needed)
brings it to once. The four copies an update could take before this model
(rehearsal copy, pre-migration snapshot, original-state capture, Doctor
`.bak`) and the updater's copy of its own runtime are not taken.

**PostgreSQL.** The state upgrade discovers SQLite only. With the shared state
on PostgreSQL it steps aside and Doctor migrates in place, which is not
transactional across a failed start. PostgreSQL runs schema changes inside
transactions, so the likely answer is one transaction per store instead of a
copy, with the launcher's code rollback unchanged. How today's PostgreSQL
migrations commit was not traced. See [decision 6](#decisions-needed).

**Plugin-owned stores** (Knowledge, browser profiles) are outside the copy by
design, so a failed trial does not rewind them. Plugin package convergence runs
only after the trial settles, which covers external plugins. A bundled plugin
that migrates its own store during a trial start is not covered. The rule to
add: a plugin store migration waits until the trial has settled. Which bundled
plugins migrate at load was not traced.

**Client credential store** and the other stores Doctor moves data into are
inside the state directory and inside the swap, including on the fallback path.

**Later, not now.** Per-migration compatibility declarations would let a release
skip the copy when the previous build can read the new schema. Nothing here
blocks it: the copy is already skipped when no version changed, and that
decision sits in one function (`outdatedDatabases`).

## Doctor

The migration step of an update is `createDoctorChain`: this build's
`doctor --fix --non-interactive` on the private copy, once, with no service
access. When it fails, the generic rebuild produces the databases, the previous
generation is pinned, and the Gateway starts.

Doctor as a command stays for diagnosis and repair that a person asks for. It
stops being a step that an update runs against live state, and it stops being
run several times per update. Two follow-ups make the split real:

- A named `migrate` entry that runs only migrations, so the chain does not pay
  for advisory checks. Today the chain runs full Doctor and ignores its exit
  code in favor of the schema check.
- Config-only migrations with no schema change. The upgrade triggers on a
  database version or the content version key. Whether every config migration
  bumps one of them was not traced. If not, the trigger needs the config's own
  written-by version.

## Service integration

The service definition names the launcher and is written once, at conversion.
An update never regenerates it, so launchd, systemd, and Scheduled Tasks need no
update-time adapter beyond "restart".

- **systemd user units and launchd:** the start command is
  `<node> <prefix>/openclaw-launcher.mjs gateway ...`. Built for Git installs.
- **Windows Scheduled Task:** the same command line. Not built.
- **The CLI** finds the selected release through the `bin` launcher, whose text
  is the same in every release and resolves through the link.
- **A running Gateway** finds the selected release by reading
  `dist/build-info.json` through the link and comparing its version and build
  with its own (`src/gateway/stale-install.ts`). A different build restarts
  it. The check is skipped for a build without a build ID and while an update
  run holds the installation, so the driver must release its lock before it
  expects the restart.
- **Node itself** is outside the release. A release that needs a newer Node is
  refused at admission, as today.

## What is deleted

Counts are non-test lines by file family at `0abe03d10082`. They come from file
names. Tracing each family's callers is part of the slice that deletes it.

| Family                                                                  | Lines  | Files | Fate                                                                         |
| ----------------------------------------------------------------------- | ------ | ----- | ---------------------------------------------------------------------------- |
| Package swap, journal, fingerprints, launcher backups                   | 12,986 | 52    | Deleted, except the staging install and integrity check that build a release |
| Recovery, database capture, snapshots, retained runtime, repair, resume | 12,905 | 60    | Deleted                                                                      |
| Doctor finalization, migrated continuation, plugin cohorts              | 12,330 | 45    | Plugin convergence and owed steps stay. The rest is deleted                  |
| Run ledger, status, result reporting                                    | 10,157 | 58    | Reduced to one run record with a handful of outcomes                         |
| Managed-service handoff                                                 | 9,583  | 53    | Deleted                                                                      |
| Candidate state copies and rehearsal support                            | 8,161  | 39    | Deleted after the bridge release                                             |
| In-place Git runner                                                     | 5,811  | 17    | Deleted. Target resolution and build steps stay                              |
| Service stop, park, refresh, recovery                                   | 4,920  | 15    | Deleted, except writing the launcher definition once                         |
| Immutable installation owner                                            | 4,660  | 16    | [Decision 8](#decisions-needed)                                              |
| Update check, channels, automatic campaigns                             | 3,315  | 12    | Stays                                                                        |
| Admission, executor leases, fences                                      | 3,218  | 15    | Replaced by one lock file                                                    |
| Release layout                                                          | 2,456  | 9     | Stays, and grows by the launcher generalization and Windows                  |
| Unclassified                                                            | 21,636 | 112   | To be traced. Mostly command plumbing around the families above              |

The expected end state is under 15,000 lines. That number is an estimate until
the first deletion slice measures it.

Also retired: the roughly 130 failure and refusal reasons the update sources
emit shrink to the outcomes a person can act on (refused before any change, release did not start and was
switched back, updated, updated with owed steps). The pages under
`docs/install/updating*`, `docs/cli/update*`, and
`docs/install/update-troubleshooting.md` are about 11,500 lines, most of them
per-fix notes of the form "this requires the fix in the installed updater".
They are rewritten, not edited.

## Migration map

### The first hop is the old updater's

New update behavior cannot run until the new code is installed. The update that
installs the first release containing this design is driven end to end by the
updater already on the machine, with its own rehearsal, captures, swap, and
Doctor runs. That release therefore has to keep everything a published updater
calls in a candidate, and it cannot shorten or repair that hop.

| What a published updater calls in the candidate                                                         | Kept until                    |
| ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `doctor --fix`, `doctor --lint --json`, the rehearsal markers, `--update-canary` startup progress       | The bridge release is retired |
| The state-copy worker and `update rehearse` (`openclaw.updateRehearsalProtocol`)                        | Same                          |
| `update-migrated-finalize` and its `--check` contract report, `update finalize`, post-core entry points | Same                          |
| The 50,000-entry and 1 GiB installed-tree limits that published updaters enforce on a candidate         | Same                          |
| The service capability check answered before config loads                                               | Same                          |

**Bridge release.** One release line keeps both systems: the old candidate-side
surface above and the new driver. Every supported source reaches it with its
own updater and adopts the layout on the update after. The release after the
bridge line deletes the old surface. This follows the existing precedent of
`2026.9.5` as a required stop for installations older than July 2026.

| Source                                    | First hop                                             | Second hop                |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------- |
| Latest stable                             | Old updater installs the bridge in place              | New driver; conversion    |
| Beta                                      | Same                                                  | Same                      |
| Extended-stable (package-only, trailing)  | Same, when its line reaches the bridge                | Same                      |
| Dev (Git)                                 | Old in-place Git runner, or the Git release path      | New driver; conversion    |
| Older than the oldest supported source    | Documented stop at the bridge, as `2026.9.5` is today | Same                      |
| Already on a release link (since #198835) | Old updater switches the link                         | New driver; adds launcher |

The check that proves a source is the published-driver Docker cell
(`scripts/e2e/published-driver-update-docker.sh`), run for each row.

### Conversion

The first update performed by the new driver converts the installation. Not the
installer and not Doctor: the driver is the only code that already holds the
target release and the service, and a conversion that is not followed by a
switch has nothing to prove it works.

1. The installed package directory, or the commit the checkout serves, becomes
   `releases/<id>` and the link takes its place. On POSIX this is the atomic
   exchange #200273 built, so the package path always names a complete package.
2. The launcher is written and the service definition is rewritten to name it.
   This is the one service write. The previous definition is kept beside it.
3. The target release is staged and the update proceeds from step 5 of the
   table above, with the converted release as the fallback.

Conversion never fails an update before the bridge is retired: when it cannot
run (no exchange call and no fallback, a prefix that cannot be written), the
bridge takes the old path and warns. After the bridge, the same condition is a
refusal before any change, with the reason and the manual command.

The installers (`install.sh`, `install-cli.sh`, `install.ps1`) write the release
layout and the launcher directly for new installations in the bridge release,
so new installations never convert.

### Existing artifacts

| Artifact                                                | Where it lives today                                         | New system                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Pending recovery (an unfinished run, a held lease)      | Run ledger rows, lease store, activation journal             | The bridge settles it with today's `update repair` before it converts. After the bridge: refuse and name the bridge.   |
| Retained updater runtimes (`openclaw-update-runtime-*`) | Install root siblings, `TMPDIR`                              | Never created. Existing ones are deleted at conversion when no live process runs from them.                            |
| Pre-migration snapshots (`.artifacts/*.databases`)      | Install root                                                 | Never created. Deleted at conversion once the converted release has settled its first trial.                           |
| Original-state captures (`<state>.update-captures/`)    | Beside the state directory                                   | Never created. Same deletion rule. Containers keep the volume mount until the bridge is retired.                       |
| Doctor `.pre-startup-migration-*.bak` and `.bak` files  | Beside each database                                         | Never created by an update. Existing ones stay under Doctor's 30-day rule; `openclaw update cleanup` still lists them. |
| Package rollback images, activation journal, stages     | Beside the package (`.openclaw.update-stage-*`, control dir) | Never created. Deleted at conversion after the journal reports no open publication.                                    |
| `.pre-<version>` files from the startup upgrade         | Beside each state file                                       | Unchanged. Same owner, same names.                                                                                     |
| Release directories and leases since #198835            | `<prefix>/releases`                                          | Unchanged.                                                                                                             |
| Git release launcher and `.trial`                       | `<state dir>/git-install`                                    | Unchanged. The launcher text is rewritten once to the shared launcher.                                                 |
| Update run ledger rows                                  | Shared database                                              | Kept as history, read-only. New runs write the reduced record. No schema change is needed to stop writing old fields.  |
| Immutable installation records                          | Installation-sibling control directory                       | [Decision 8](#decisions-needed).                                                                                       |

Three open pull requests clean up after the current system:
[#202590](https://github.com/openclaw/openclaw/pull/202590) (retained runtime
reclaim), [#202591](https://github.com/openclaw/openclaw/pull/202591) (old
snapshot retirement), and
[#202556](https://github.com/openclaw/openclaw/pull/202556) (Doctor capture
retention). Going forward the new system creates none of those artifacts, so
none of the three is needed for installations that have converted. Existing
installations still need them until they convert, and the conversion's deletion
rules above are the same work. They should merge on their own schedule and the
conversion should call their owners, not reimplement them.

### Rollback to a release from before the change

After conversion, the fallback of the first new-driver update is the converted
bridge release, so an automatic rollback lands on the bridge. Going back
further is a downgrade and keeps today's contract: `openclaw update --tag <older>`
checks that the target can read current state and refuses a target behind a
migration. An older package installed that way is a plain directory
over the link, which that release's own updater understands (run for
`2026.10.9` and `2026.11.3` on #197949). The service definition names the
launcher, which starts whatever the link or directory at the slot holds, so it
does not need to be rewritten for a downgrade.

### Config keys and flags

| Surface                                                                                                                | Change                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update.channel`, `update.checkOnStart`, `update.auto.*`                                                               | Unchanged. No config migration.                                                                                                                            |
| `--channel`, `--tag`, `--dry-run`, `--json`, `--yes`, `--no-restart`, `--timeout`                                      | Unchanged. `--no-restart` defers the switch to the next service start, which selects the release without the two-start fallback, as Git releases do today. |
| `--full-integrity-check`, `--accept-capabilities`, `--source-root`                                                     | Retired with the paths that read them, after the bridge.                                                                                                   |
| `update repair`, `update recover`, `update migrate`, `update finish`, `update restore`, hidden `admit` and `preflight` | Retired after the bridge. `update repair` becomes "settle owed steps".                                                                                     |
| `update cleanup`                                                                                                       | Kept. It lists and removes old-system artifacts and unselected releases.                                                                                   |
| `update adopt-immutable`                                                                                               | [Decision 8](#decisions-needed).                                                                                                                           |
| `update status`                                                                                                        | Kept. Reports the link, the releases, the trial, and owed steps.                                                                                           |
| New config keys                                                                                                        | None proposed.                                                                                                                                             |

### Docs to rewrite

`docs/install/updating.md` (2,880 lines) and its three subpages,
`docs/cli/update.md` and its three subpages, `docs/install/update-troubleshooting.md`,
the upgrade sections of `docs/install/docker.md` and `docs/install/kubernetes.md`,
`docs/install/installer.md`, `docs/install/development-channels.md` (Git rows), and
the Doctor pages that describe update-time repair. Published anchors are kept
with named anchors. The "update implementation contract" section becomes this
page's rules plus the first-hop table.

### Rollout

| Stage | Change                                                                                                                | Reversible |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | The launcher and trial move from Git releases to every release link. Additive.                                        | Yes        |
| 2     | The new driver, behind the same command, for installations already on a release link with a launcher.                 | Yes        |
| 3     | Conversion for npm prefixes the user manages, and Windows junctions. Installers write the layout.                     | Yes        |
| 4     | Entry points (Control UI, automatic updates, Gateway tool) call the driver. Containers drop entrypoint Doctor.        | Yes        |
| 5     | **The bridge release ships** with stages 1 to 4 and the whole old candidate-side surface.                             | Yes        |
| 6     | **Point of no return:** delete the in-place runners, the swap, captures, handoff, and the old candidate-side surface. | No         |

After stage 6, an installation that skipped the bridge cannot update with its
own updater to a current release and must stop at the bridge first. Stage 6
needs explicit approval and waits for the oldest supported source to be at or
past the bridge.

## Live testing

**The dev channel can track a branch other than `main` without a code change.**
The local branch name is fixed (`DEV_BRANCH = "main"` in
`src/infra/update-channels.ts`), but the source is read from that branch's Git
tracking configuration (`readGitUpdateFetchTarget` in
`update-git-metadata.ts`, called from `update-runner-git-target.ts`), and complete tracking configuration takes
precedence over `origin/main`. A test installation therefore runs:

```bash
git clone https://github.com/openclaw/openclaw ~/openclaw
git -C ~/openclaw branch --set-upstream-to=origin/<feature-branch> main
```

This was read from source and the channel documentation. It has not been run.

**Loop.** Each round merges `main` into the feature branch, pushes, and runs
`openclaw update --channel dev --yes --json` in the test installation, which
builds the new commit as a release, switches, and restarts. Rounds differ in
what they inject:

| Round                                 | Asserts                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Plain update, no schema change        | Outage in seconds, no state copy, link moved, trial deleted, sessions readable                      |
| Update across a schema bump           | Copy and swap ran once, `.pre-<build>` present, row conservation clean, peak disk within the budget |
| Release that crashes on load          | Two counted starts, link back, `.pre-<build>` restored, old build ready, update reports failed      |
| Release that starts but never readies | Same, through the readiness deadline                                                                |
| Driver killed at each step            | The next start or next update converges with no manual command                                      |
| Power-loss stand-in                   | Container killed between the plan write and the renames, then restarted: the plan finishes          |
| Disk full during the copy             | Refusal with byte counts, live state untouched, old release serving                                 |
| Update started through the Gateway    | Same result as the CLI, with the driver inside the service's process group                          |
| Base versus branch                    | The same seeded state updated by the base commit's updater and by the branch, timings side by side  |

**Where.** First in Crabbox `local-container` leases launched on the Mac Studio
from a pushed commit, each with its own state directory, port, and a user
systemd instance or a supervised launcher loop inside the container. The seeded
state is the populated prior-release corpus the startup upgrade already tests
with, plus a scaled database to make copy time visible. Only after every round
passes there: a real host that is not a production Gateway, with a copy of real
state. The live Gateways on `openclaw-fsn1` and the Studio are never updated,
restarted, or inspected by this loop, and their databases are never opened.

## Decisions needed

Each default is what the first slices assume until answered.

| #   | Decision                                                                            | Options                                                                                                                                                                                                                                                   | Recommendation and default                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How this relates to #197949 and its author's ongoing slices                         | (a) Merge the two designs into one page and one sequence of slices. (b) This page supersedes it. (c) Keep #197949's incremental route and drop this one.                                                                                                  | (a). The layout, link, leases, launcher, and state upgrade are that work. The differences are scope (every install kind), the fallback paths, and deletion. Two writers in 500 files will collide.  |
| 2   | Swap state before the health check, or health-check a copy before the swap          | (a) As built: swap at start, trial, rename back on failure. (b) Start the new Gateway on the copy at another path, check health, then swap.                                                                                                               | (a). It exists and is tested. (b) needs the Gateway to run from a relocated state directory, which today requires rewriting absolute paths in the databases twice, and it still loses trial writes. |
| 3   | Package-manager-owned installs: pnpm, Bun, Homebrew, Nix, system packages           | (a) Keep the in-place swap for them (about 13,000 lines stay). (b) `openclaw update` runs the manager's command, state stays transactional through the Gateway-start upgrade, code rollback is the manager's. (c) Refuse and print the manager's command. | (b) for pnpm and Bun, (c) for Homebrew, Nix, and system packages (already the case for some). npm prefixes the user manages take the linked root. This is a contract change for pnpm and Bun users. |
| 4   | Retention of replaced state files (`.pre-<build>`)                                  | (a) Today: one generation until the next upgrade (steady disk 2x). (b) Delete 24 hours after the trial settles (steady 1x). (c) Delete when the trial settles.                                                                                            | (b), matching release retention. Pinned generations from the fallback rebuild stay until Doctor reviews them. This is a retention change.                                                           |
| 5   | A manual rollback command inside the retention window                               | (a) None; downgrade keeps today's refusal behind a migration. (b) `openclaw update --rollback`: switch back and restore `.pre-<build>`, losing writes since the update, with confirmation.                                                                | (a) now. (b) is small once 4 is decided, and is the first thing an operator will ask for.                                                                                                           |
| 6   | PostgreSQL-backed state                                                             | (a) Leave it on in-place Doctor at start (not transactional across a failed start). (b) One transaction per store. (c) Server-side copy (template database or schema clone).                                                                              | (a) for the first slices, then (b) after tracing how the migrations commit. (c) needs privileges many deployments do not grant.                                                                     |
| 7   | Plugin-owned stores during a trial                                                  | (a) Accept that they are not rewound. (b) Defer plugin store migrations until the trial settles. (c) Add them to the copy.                                                                                                                                | (b). (c) doubles the largest stores for a rare failure.                                                                                                                                             |
| 8   | The immutable installation owner (Team deployments, 4,660 lines)                    | (a) Keep as is. (b) Make it a caller of the shared link, launcher, and state upgrade, keeping only its privilege separation. (c) Retire it in favor of the shared layout.                                                                                 | (a) until the shared layout has run in production, then (b). It has operators and an adoption record; changing it is a public contract change.                                                      |
| 9   | Windows                                                                             | (a) Junction layout in the first wave. (b) Windows stays on the in-place swap until POSIX is proven, which keeps the swap code past stage 6 for one platform.                                                                                             | (a), after POSIX slices, before stage 6. #199706 already decided Windows moves to junctions.                                                                                                        |
| 10  | The bridge release and stage 6                                                      | Which release is the bridge, and how long before the deletion.                                                                                                                                                                                            | One stable line, at least one extended-stable cycle. Needs release-owner approval.                                                                                                                  |
| 11  | Reducing the run record and failure vocabulary                                      | (a) Keep the protocol schema and write fewer values. (b) New, smaller schema.                                                                                                                                                                             | (a). No schema or protocol bump. Readers (Control UI, status) drop what is no longer written.                                                                                                       |
| 12  | Containers: remove the entrypoint Doctor pass in favor of the Gateway-start upgrade | (a) Keep both. (b) Remove the entrypoint pass and the `<state>.update-captures` volume requirement.                                                                                                                                                       | (b), in the bridge. It changes the documented volume layout.                                                                                                                                        |

## Evidence limits

- This page comes from reading source and merged pull request descriptions at
  `0abe03d10082`. Nothing was run for it.
- Read in full: `src/state/state-upgrade.ts`, `state-upgrade-startup.ts`,
  `state-upgrade-doctor.ts`, `git-release-launcher.ts`, `git-release-paths.ts`,
  `package-release-slot-path.ts`, and the first half of `git-release.ts`. Read in
  part: the update command, the Git target resolver, and the update pages. The
  rest of the 503 files were counted, not read.
- Line counts are by file-name family. A file can serve two families, and the
  "unclassified" 21,636 lines were not assigned.
- The host measurements that motivated this work (53 attempts, 22 succeeded, 9
  to 48 minutes, four refused database rollbacks) are from updaters older than
  the release layout and the startup upgrade. No run of the current Git release
  path on a large state directory has been measured. The first slice does that.
- Not traced: how the package release path on owned prefixes handles state
  today (it still runs the old stop, capture, and Doctor sequence around the
  link switch, as far as the command file shows), PostgreSQL migration commits,
  which plugins migrate their own stores at load, config-only migrations with no
  version bump, Windows junction behavior under a running Gateway, and every
  caller of the managed-service handoff.
- The count of failure reasons is 132 distinct `reason` literals in the update
  sources by text search, not a closed vocabulary.

## Related

- [Team immutable update design](/reference/team-immutable-update-design)
- [How an update runs](/cli/update/how-updates-run)
- [Updating](/install/updating)
- [Release channels](/install/development-channels)
- [Database schemas](/reference/database-schemas)
