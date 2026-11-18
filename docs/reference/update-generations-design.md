---
doc-schema-version: 1
title: "Update generations design"
summary: "Design proposal: release directories behind a linked package root on OpenClaw-owned prefixes, and staged transfer of update work to the candidate"
read_when:
  - Designing how OpenClaw-owned install prefixes replace their code during an update
  - Deciding whether a user-scope installation should reuse the immutable installation owner
  - Reviewing which update steps run in the installed updater and which run in the candidate
---

# Update generations design

**Design proposal. One slice has merged and the release-directory slice is in review; nothing else here is built. A maintainer accepted the seven [decisions](#decisions) on November 13, 2026. That sets the direction; each slice still needs its own review.**
Two changes to `openclaw update`: keep each release in its own directory on
prefixes that OpenClaw owns and switch between them by repointing one link, and
move update work out of the installed updater into the candidate in stages.

This is the fourth version. Source reviews at
`0001c18108e9f13426bbc9eaedd656e4bd86cef6`, `96a52f29220a8`, and
`a83f74375ccaa` on November 12 and 13, 2026 changed the plan three times. See
[Rejected approaches](#rejected-approaches). Counts under "Why change it" are
from `6acf398088c430ba93944a5bc07eec1b2299ac00`.

| Slice                                        | Status                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate-owned rehearsal                    | Merged in [#197922](https://github.com/openclaw/openclaw/pull/197922).                                                                                                                   |
| Release directories behind a linked root     | Merged in [#198835](https://github.com/openclaw/openclaw/pull/198835).                                                                                                                   |
| Owed steps after the commit point            | Two slices merged: [#200331](https://github.com/openclaw/openclaw/pull/200331) and [#200507](https://github.com/openclaw/openclaw/pull/200507). Backup retirement and collection remain. |
| Stop, publish, and rollback in the candidate | Not designed.                                                                                                                                                                            |

## Why change it

The update design is sound: prepare and rehearse while the previous Gateway
serves, keep one writer per state directory, and never roll code back across a
migration. The cost comes from two structural choices.

| Measure                                                             | Value                         |
| ------------------------------------------------------------------- | ----------------------------- |
| Non-test update code                                                | 121,467 lines in 535 files    |
| Commits to update code in the prior 60 days                         | 1,720, of which 999 are fixes |
| Doc caveats of the form "requires the fix in the installed updater" | 278                           |
| Entry and byte limits on package fingerprint scans                  | 500,000 / 8 GiB               |

**The old release leaves its path during a package update.** The swap itself is
two directory renames: the installed package moves to a backup and the staged
one moves in (`createPublicationOwner` in
`src/infra/package-update-publication-owner.ts`). Everything around those
renames exists because the old tree is displaced from a shared location. The
updater hashes whole trees before and after, saves and restores launchers,
deletes the old tree once the new one verifies, and keeps a private copy of its
own runtime because its files are about to move.

**The installed updater drives the whole run.** A fix in the new release cannot
help the release that is failing, which is why `2026.9.3` through `2026.9.5`
each carry a manual procedure.

### Measured

One run of the published-driver Docker cell on November 12, 2026: published
updater `2026.11.3`, candidate #197922 at `758582e`, linux/arm64, a small
fixture state. The installed package tree was 46,250 entries and 591 MB.

Published updaters refuse a candidate whose installed tree exceeds 50,000
entries or 1 GiB, and that check cannot be patched after release. On November
16, 2026 `main` installed to 52,229 entries, because a dynamic import had
pulled the Gateway graph into the transcript reader worker's private build.
[#200321](https://github.com/openclaw/openclaw/pull/200321) restored 46,826
entries and added a build guard that pull requests now run. The margin under
the cap is small, and any release layout work has to keep it.

| Step                                   | Time    |
| -------------------------------------- | ------- |
| Updater copying its own runtime        | 14.0 s  |
| Package install into staging           | 18.6 s  |
| Rehearsal, all checks                  | 21.0 s  |
| Package swap step                      | 37.6 s  |
| Post-swap Doctor, inside the swap step | 19.4 s  |
| Post-plugin Doctor                     | 9.9 s   |
| All recorded steps                     | 139.1 s |

The swap step's clock runs from the baseline scan through stopping the Gateway,
the two renames, the post-swap Doctor, and deleting the old tree. That the
Doctor run is inside it is an inference: the whole activating phase lasted
45.8 s, which cannot hold a 37.6 s swap and a separate 19.4 s Doctor. The
artifacts do not split the remaining 18 s between stopping the Gateway and file
work. The third version of this document counted the post-swap Doctor twice.

The swap step is slower with older updaters against the same candidate: 37 to
38 s with `2026.11.x`, 69 to 70 s with `2026.10.x`, and 109 s with `2026.9.9`.

What a link flip can remove on the prefixes it covers is the updater's copy of
its own runtime and the file work inside the swap step: at most about 32 s of
139 s in this run. Doctor, rehearsal, and the staging install are untouched.

## Prior art

| Question                      | Codex                         | Claude Code                       | Pi                                     | Hermes                                     |
| ----------------------------- | ----------------------------- | --------------------------------- | -------------------------------------- | ------------------------------------------ |
| Package-manager-owned install | Runs the manager in place     | npm self-updates; others manual   | Runs the manager, or migrates from npm | Refuses and prints the owner's command     |
| Release directories used for  | Its standalone installer only | Its native installer only         | Its managed installer only             | Dependency generations; code is a checkout |
| Pointer                       | `current` symlink             | Launcher symlink into `versions/` | `current-version` text file            | Generation record                          |
| Retention                     | Never prunes                  | Pointer, running, two newest      | Active plus the updater's own          | Unselected, unleased, and a day old        |
| Verification before switching | SHA-256 and `--version`       | Signed manifest checksums         | Pinned lockfile install, `--version`   | Compile startup files before and after     |
| Old-to-new handoff            | None                          | None                              | None                                   | One versioned request, correlated receipt  |

Sources: [Codex installer](https://github.com/openai/codex/blob/main/scripts/install/install.sh),
[Claude Code setup](https://code.claude.com/docs/en/setup),
[Pi package manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/package-manager-cli.ts),
and [Hermes update completion](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/source-update-completion.md).

None of the four runs code from its own release directory while a
package-manager-owned copy of an older version stays installed as a launcher.
Release directories appear only where the tool's own installer owns the layout.

OpenClaw already ships the same pattern in four places:

| Where                     | Pointer                                                               | Source                                        |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Immutable installation    | `current` symlink, published by a journaled temporary link and rename | `publishImmutablePointer`                     |
| Node host runtime         | `current` symlink, or a junction on Windows                           | `activateRuntime` in `node-host-launcher.mjs` |
| Packaged macOS app        | `current` and `previous` links to build directories                   | `BundledRuntime+Seeding.swift`                |
| pnpm global installations | The package root is a link that pnpm repoints                         | `resolveCliEntrypointPathForService`          |

## Installation layouts today

| Layout                        | Who owns it                                                                                                                                                             | Source                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `install.sh`, the default     | npm. It runs `npm install -g` into the user's npm prefix.                                                                                                               | `scripts/install.sh`                       |
| `install-cli.sh`              | OpenClaw. Default prefix `~/.openclaw`. `tools/node-v<version>/` is both the private Node and the npm prefix. `bin/openclaw` is a wrapper that names one package entry. | `scripts/install-cli.sh`                   |
| Durable service copy          | OpenClaw. An npm prefix at `<stateDir>/npm` that `openclaw update` updates in place.                                                                                    | `src/daemon/durable-service-entrypoint.ts` |
| Node host runtime generations | OpenClaw. `<stateDir>/node-runtime/releases/<version>-<digest>`, each a private npm prefix.                                                                             | `node-host-launcher.mjs`, `src/node-host/` |
| Packaged macOS app            | The app. Host-owned build directories under `<stateDir>/runtime`; `openclaw update` refuses it (`refuseHostOwnedUpdate`). `install-cli.sh` is its legacy path.          | `apps/macos/Sources/OpenClaw/NodeMode/`    |
| Immutable installation        | OpenClaw, root-owned, after explicit adoption.                                                                                                                          | `src/infra/update-immutable-*.ts`          |

Facts from the source that decide between the routes below:

- **The service definition stores the path it was given, not the resolved
  one.** `resolveCliEntrypointPathForService` in `src/daemon/program-args.ts`
  prefers the original, possibly symlinked path so that the definition survives
  version changes.
- **No launch path passes `--preserve-symlinks` to Node.** Node resolves the
  entry file's real path at start, so a process started through a link stays
  inside the directory the link named at that moment.
- **Plugin links hold the resolved host path, but only as a by-product.**
  `src/plugins/plugin-peer-link.ts` links `node_modules/openclaw` to the running
  process's host root. No comment or test requires the resolved form. The
  post-update plugin step relinks from the new release, and
  `refreshStartupPluginQuarantine` repairs a stale link at Gateway start.
- **The swap code already accepts a linked package root.**
  `createNpmPackageRootLinkLifecycle` in `src/infra/package-update-npm-root.ts`
  backs up by renaming the link and retires by unlinking it, with no tree
  hashing. Journaled activation is skipped for a linked root today.
- **The handoff root check compares resolved roots.**
  `assertManagedServiceUpdateHandoffRoot` rejects a post-core child that runs
  from a different resolved root, with an exception only for a pnpm owner.

## Part A: release directories

Four routes were evaluated.

### Route 1: extend the immutable installation owner

The immutable owner already has release directories, journaled pointer
publication, a launcher, recovery, and verification. Most of it does not carry
over to a user-owned installation.

| Assumption in the immutable owner                                     | Where                                                             | What lifting it takes                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Root owns every directory, the pointer, the journal, and the launcher | `update-immutable-layout.ts`, `openclaw-immutable-launcher.mjs`   | New design. With one account the protection is advisory.                           |
| Build, runtime, and root accounts are distinct                        | `update-immutable-build.ts`, `update-immutable-install-schema.ts` | New design.                                                                        |
| A generation is a source build keyed by a 40-hex Git SHA              | `update-immutable-generation.ts`, `update-immutable-install.ts`   | New design. Verification needs `.git` and build stamps that the npm tarball omits. |
| Only equal schema versions activate                                   | `update-immutable-activation.ts`                                  | New design. Ordinary releases cross schemas routinely.                             |
| System-scope systemd with cgroup v2 stop proof                        | `update-immutable-service.ts`                                     | New adapters for launchd, user systemd, and Task Scheduler.                        |
| The launcher starts the Gateway only, with `process.execve`           | `scripts/openclaw-immutable-launcher.mjs`                         | New adapter. No CLI launcher exists, and none for Windows.                         |
| Adoption binds an installation that is already running                | `update-immutable-install.ts`                                     | New design. There is no bootstrap.                                                 |
| Gateway `update.run` is refused                                       | `src/gateway/server-methods/update-admission.ts`                  | New design. App and Control UI updates arrive that way.                            |
| Nothing is collected                                                  | `update-immutable-install-schema.ts`                              | New design. Each generation is a full checkout plus a full recovery copy.          |

**Verdict: do not extend the immutable owner to user installations.** Its safety
rests on privilege separation. Reuse its pointer publication pattern.

### Route 2: rebind the installation to a new package root

The third version of this document recommended this. Each release gets its own
directory, and activation rewrites the three things that name the package root:
the service definition, the `bin/openclaw` wrapper, and plugin links.

The source trace found the bindings feasible but the route more expensive than
the link flip for no added benefit:

- Every update changes three paths, so a kill between effects leaves a mixed
  installation that a journal must reconcile.
- The activation journal is located and keyed by the package path
  (`resolvePackageActivationAnchor`) and assumes one path whose contents change.
  A moving root needs a different journal shape.
- `activePackageRoot` in `src/infra/package-update-steps.ts` is not a rebinding
  hook. It changes only for pnpm and Bun stages.
- The installer layout changes in shell, TypeScript, and Swift at once.

**Verdict: superseded by route 3.**

### Route 3, recommended: a linked package root

The installed package directory keeps the path it has today and becomes a link
to a release directory. An update installs the new release beside the old one
and repoints that one link.

```text
<npm prefix>/                           install-cli.sh: <PREFIX>/tools/node-v<version>
  bin/openclaw                          unchanged; ../lib/node_modules/openclaw/openclaw.mjs
  lib/node_modules/
    openclaw -> ../../releases/2026.12.1-.../lib/node_modules/openclaw
  releases/
    2026.11.4-.../                      private npm prefix
    2026.12.1-.../
```

Releases live under the npm prefix, not under `install-cli.sh`'s `<PREFIX>`,
because the stable path, the launcher text, and the "same prefix" rule are all
relative to the npm prefix. The link text is relative so the prefix can move.

**A release is a private npm prefix.** `prepareNodeRuntimeUpdate` in
`src/node-host/auto-update-install.ts` already builds one: it reads the registry
manifest, checks the tarball's sha512 integrity, and installs through the
shared `runGlobalPackageUpdateSteps`. Lift its generic part into one shared
owner and make the node host a caller that supplies its schema checks. The
staging install the package path does today becomes the release, so nothing is
moved after it.

**Activation is one rename.** With the Gateway drained and stopped as today:

1. Create a temporary link to the new release and record the intent with the
   link's identity, as `publishImmutablePointer` does.
2. Rename the temporary link over the package root. On POSIX this replaces the
   old link atomically. On Windows a junction cannot be replaced that way, so
   the flip is two renames with a `.previous` name, as `activateRuntime` does
   for the node host.
3. Continue as today: Doctor, post-core plugin convergence,
   `gateway install --force`, start, and verification all run from the new
   release.

**The first update adopts the layout.** When the package root is still a plain
directory, the updater moves it into `releases/` as the previous release and
puts the link in its place. This reuses the displacement rename the swap already
does; the difference is that the old tree is kept, not deleted.

**Rollback points the link back.** A route 3 updater never writes to the
previous release, so there is no backup to verify byte for byte. An older
updater can rewrite a release directory, so rollback first checks the release
against its recorded identity. Config and service definition
restore stay as they are, and so does the rule that code does not roll back
across a migration.

**What stays valid without rewriting:** the service definition, the wrapper,
npm's `bin` launcher, and shell completion, because each names the stable path
or no package path at all.

**What needs new work:**

- Resolved roots that are compared across the update. No new rule is needed in
  `assertManagedServiceUpdateHandoffRoot`: the parent already rebinds the
  post-core child to the activated root (`update-command-post-core.ts`), which
  is how a pnpm generation change passes today. The updater that flips has to
  return the stable package path as its result root. Three other comparisons
  need work when the flip is built: the executor's `enter` key, the child
  grant, and the managed handoff helper's recovery after a failed or
  still-starting update, which requires the result root to resolve to its
  lease key.
- A slot resolver, so the updater knows the link's own path, and a small
  record of each switch. See [recording the switch](#recording-the-switch).
- Plugin links. The existing relink and startup repair cover a flip. Linking to
  the stable path instead would remove the stale state altogether; decide
  during implementation.
- Release identity. A published driver that runs on a linked root rewrites the
  release directory behind the link in place (see
  [first hop](#update-behavior-and-first-hop)). A route 3 updater records each
  release's version and build when it installs it, reads them back from the
  directory's content before it trusts the directory, and treats a mismatch as
  input to adoption, never as a rollback target. The directory name is a label
  only.
- Leases and collection, below.
- `openclaw update status` reporting the active and retained releases.

#### Recording the switch

An earlier draft of this page proposed adding a pointer intent to the
activation journal. A design pass at `649ca5f879f1e` recommends against it, and
a maintainer directed on November 13, 2026 that the recommended option be taken.
The switch gets no activation-journal record.

**Why the journal is not needed here.** The journal exists to survive two
things: a package path that is missing between two directory renames, and
launchers that are replaced one at a time. A link switch has neither. One rename
is atomic, so the link always names a complete release. On POSIX the `bin`
launcher is a symlink whose text, `../lib/node_modules/openclaw/openclaw.mjs`,
is the same in every release, so nothing outside the release directory changes
except the link. Codex and Pi work the same way: a pointer replaced through a
temporary name, a lock, and cleanup of leftovers at the next start. Neither
keeps a crash journal for the switch.

**Why extending the journal would cost more than it gives.**

- The journal is one SQLite row in a control directory named by a hash of the
  install key, and the install key is a real path. On a linked root it would
  sit inside the old release, which is where the published-driver cell found
  it.
- Its schemas are strict. An older release that reads a row with an intent or
  field it does not know refuses to update until the row is repaired.
- Preparation moves the candidate into the journal's anchor, and a release
  directory must not move.
- Every caller that settles an activation selects by a directory identity.

**What is recorded instead.** The link is the only source of truth for the
selected release. The update run record gains one optional field,
`origin.packageRelease`, holding the slot (the link's path) and the path,
identity, version, and build of the release the update came from and the one it
intends. It sits beside `origin.packageStage`, which already holds a path and an
inode. The field is advice for the next run and is always rechecked against the
filesystem. Older readers drop a key they do not know; that has to be shown
against a published reader before it ships. No table, journal record, or schema
version changes.

Adding the field is still a change to a durable record, so it falls under the
[storage design checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).
This section is that record.

**Order of an activation.**

1. Take the install lease and the slot lease at the link's path. Remove stale
   temporary links by their operation-owned name.
2. Verify the candidate release: fingerprint, version, build, launcher text,
   and owner. If its launcher text differs, this run takes the swap instead
   (see [the layout never fails an update](#the-layout-never-fails-an-update)).
3. Capture the link's inode, its target text, and the identity of the
   directory it resolves to.
4. Write `origin.packageRelease`.
5. Stop the service, as today.
6. Create the temporary link and sync the directory.
7. Recheck the lease, the captured link, and the candidate.
8. Rename the temporary link over the link.
9. Confirm the link's inode is the temporary link's, and sync the directory.

Rollback repeats steps 6 to 9 with the captured target text, after confirming
the previous release against its recorded identity.

| Crash                            | State on disk                              | Next run                                                                         | An older release           |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------- |
| Before step 6                    | Old link                                   | Nothing to do. The candidate belongs to collection.                              | Updates normally           |
| After step 6, before step 8      | Old link and a temporary link              | Removes the temporary link under the slot lease                                  | Ignores it                 |
| After step 8, before step 9      | Either release; a power loss can revert it | Reads the link: the intended release means continue, the old means not activated | Runs whichever is selected |
| After step 9                     | New link                                   | The existing run reconciliation, cohort settlement, and handoff recovery         | Same                       |
| The link matches neither release | Someone replaced it                        | Leaves it and reports, as settlement does for a manual install                   | Same                       |

**Invariants.** The link always resolves to a complete release. It changes only
under the slot lease, with the lease checked immediately before the rename. The
rename replaces only the link that was captured. Cleanup removes symbolic links
only and never recurses. Launcher text is the same in every release.

**What this does not cover.**

- **Nothing holds the link's path today.** Root discovery prefers the real path
  of the entry file (`openclaw-root.ts`), and the npm prefix is inferred from
  that root. On a linked root the updater therefore treats the release
  directory as its prefix, which is why published drivers swap inside it. A
  slot resolver has to come first.
- **Turning a plain directory into a link** has a moment with no package path.
  See [as built](#slice-4-as-built) for the design that was chosen.
- **Child admission after a switch** compares a resolved root with the lease
  keys (`update-command-executor-children.ts`). After a switch the link
  resolves to the new release. This is expected to refuse post-core children
  and was not run.
- **Interrupted managed handoff** names the package candidate from the journal
  today. It has to read through the link and take the candidate from the run
  record.
- **Local override replay** writes into the candidate, which conflicts with a
  release that is written once.
- **An operator's `npm link` to a checkout** is not a release directory and
  stays on today's path. The switch applies only when the link resolves to a
  release directory under the same prefix and owner.
- **Windows.** Launchers there are files, not links, so the launcher argument
  does not hold. Windows does not get the linked layout in this work.
- Rename over a symbolic link and directory sync on APFS, overlayfs, and
  network filesystems were not tested.

Today's swap for a root that is already a link has no recovery if the process
dies between moving the old link away and putting the new tree in place. That
is an existing defect, separate from this design.

**Retention.** Each process holds a lease on the release it runs, because it
keeps loading files from that directory after a flip. Collection removes a
release only when the link does not name it, no lease holds it, no open update
run names it, and it is past a minimum age. A release behind a
completed migration is collected once the migrated Gateway verifies.

**What it retires, on linked roots only:** the live-tree backup, baseline
fingerprinting of the old tree, rollback byte verification, deleting the old
tree inside the activation window, and the updater's private copy of its own
runtime. The updater keeps that copy today because activation replaces the
files it is running from (`src/infra/update-retained-runtime.ts`). Whether it
has other uses that survive a flip is not traced. The swap code stays for
package-manager-owned installations and for adoption.

**Scope.** The `install-cli.sh` prefix and the durable service copy. The
packaged macOS app already has its own build links and is not updated by
`openclaw update`. The node host keeps its launcher and gains the shared
release installer and collection.

#### The layout never fails an update

Release directories make an update faster and its rollback cheaper. They are
not a condition for updating. When the linked layout cannot be used for a run,
and that is known before the first change to the installation, the run takes
today's swap, records a warning that names the reason, and finishes. The next
update tries the layout again.

This covers every precondition of the switch:

- the candidate's `openclaw` launcher is not the link the prefix already has.
  The comparison covers only the launchers the update manages, so a candidate
  that adds another command still switches
- `releases/` cannot be created, or is on another filesystem than the package
  path
- the package path or the candidate cannot be captured or read
- the Gateway service starts a path inside a release. Switching the link
  would leave the service on the old release, so the update replaces that
  release in place and reports the package path as its result. The restart's
  service refresh then binds the service to the package path, and the update
  warns with the `openclaw gateway install --force` command for the case where
  it does not. Once the service names the package path, the next update
  switches releases.

A refusal remains only where another writer is changing the installation
during the run: the link or the candidate changed between capture and the
rename, and a previous release that was rewritten is not a rollback target.
Those are rechecked immediately before a rename and stop that rename, not the
layout.

This follows the repository rule that `openclaw update` finishes best effort
on every installation and refuses only for concrete data at risk.

#### Slice 4 as built

The implementation follows the sections above with these changes, each forced by
something the source showed.

- **Releases are under the npm prefix.** See the layout above.
- **The installation's identity is the link.** `resolveUpdateInstallRoot`
  returns the link's own path for a release link instead of following it, and
  maps a path inside the release the link currently selects to the link, which
  is where a process finds its own root by real path. The executor's install
  key, child admission, the sentinel, the post-core and native-receiver root
  checks, and the managed handoff helper's lease key therefore do not change
  when the link moves. A post-core child at the link runs under the
  installation's lease; before this, it acquired a separate lease for the new
  release path. A published updater on a linked root keys its leases by the
  release's real path instead, so a candidate child checking its executor
  grant takes the parent's spelling when `updateInstallRootsMatch` says both
  name one installation (the published-driver cell failed there without it).
  Gateway-initiated updates map the Gateway's release path to the link at
  admission. `resolveOpenClawInstallationRootSync` gains the same rule, which
  covers a start through the `bin` launcher; `resolveUpdateRoot` applies it
  only when the result is a release link. Plain directories and `npm link`
  checkouts keep their real path.
- **A release is staged where it stays.** `runGlobalPackageUpdateSteps` takes
  a `releaseLayout` flag that only `openclaw update` sets. On a release link,
  or a plain directory on an owned prefix, the staging prefix is created as
  `releases/<label>` instead of `.openclaw.update-stage-*`, and the swap
  delegates to the switch. The node host is not changed: making it a caller
  would have moved its staging and activation without removing code.
- **Order.** `origin.packageRelease` is validated before the service stops
  and written after it (steps 4 and 5 above are swapped), through the run's
  phase writer, which records the `activating` phase there. It must be written
  before the transaction captures the databases: a first version wrote it
  after that capture, and the rollback cell showed database rollback then
  refusing ("databases changed after update ledger writes"), which also
  withheld the link rollback. A crash before the record leaves the old link.
- **Rollback reads the link.** A switch can fail after its rename, for
  example when the directory sync returns `EIO`. Rollback therefore decides
  from the link on disk, not from whether the switch returned: the previous
  release's text means nothing to do, the candidate's text means switch back,
  and anything else is another writer and is refused.
- **Crash after the rename, unmanaged.** A managed handoff reads the link and
  the run record (the table above). A plain CLI update killed between the
  switch and its post-switch Doctor leaves the candidate selected and the run
  open, for the existing reconciliation in `openclaw update repair`, which runs
  from whichever release the link names. No code was added for that case and
  it was not exercised. Since
  [#200866](https://github.com/openclaw/openclaw/pull/200866), a plain
  `openclaw update` finishes a killed run whose candidate is installed but not
  confirmed, when that run reserved its plugin recovery (see "Finishing a
  killed update" below). A kill right after the link switch was not among the
  cases it ran.
- **A service bound to a release path.** A published updater run through the
  link writes the release's real path into the service definition (seen in
  the linked-root cell: `ExecStart` named `releases/2026.11.3/.../dist/index.js`).
  After a switch that service would keep starting the old release, and
  post-switch service revalidation correctly calls it another installation.
  The first version of #198835 refused before any change when the managed
  service starts a path inside a release, and named `openclaw gateway install
  --force` from the package path as the fix. Decision 8 replaces that refusal.
  The plan was to switch the link and then rebind the service as an
  install-root refresh, like a pnpm generation change. In the Docker cell the
  post-update ownership check ran before the rebind, called the service
  another installation, and left the Gateway stopped. As built, the update
  replaces the release the service starts in place, so the service starts the
  new version without a rewrite, and reports the package path as the update
  root so the restart's service refresh binds the service there. With
  `--no-restart` the service keeps the release path until its next restart.
  Separately, `--no-restart` with a running Gateway can fail on any package
  install: the Gateway restarts itself for the replaced installation while
  update Doctor stops it. That was measured on a plain install from `main`,
  it is independent of release directories, and
  [#200181](https://github.com/openclaw/openclaw/pull/200181) fixes it: the
  updater accepts one process change when the newest recorded shutdown
  belongs to the process it inspected and names the replaced installation,
  then inspects again, warns, and drains and stops the restarted Gateway. Not
  covered: a restart inside systemd's `RestartSec` window, and a Gateway that
  restarts from rolled-back files after a failed update. The in-place Docker
  cell still stops the Gateway first; running it with the Gateway up is a
  follow-up.
  This installation's own service writes keep the package path (the adoption
  cell checks the unit).
- **Launchers.** The first version refused before any change when a candidate
  adds or renames a `bin` entry. Decision 8 replaces that with the swap for
  that run, which installs the new launchers and leaves a plain directory; the
  next update adopts again. The comparison covers only the launchers the swap
  publishes (`openclaw`). Comparing every `bin` entry made a candidate with an
  added command fall back on every update and never adopt the layout.
- **Adoption** turns the plain directory into `releases/<label>` and puts a
  link in its place, then switches as usual. The first version did that with
  two renames, and between them the package path was missing: an updater
  killed there left `openclaw` unable to start, with a manual recovery.
  [#200273](https://github.com/openclaw/openclaw/pull/200273) prepares the
  link at the release path and exchanges the two in one call (`renameat2`
  with `RENAME_EXCHANGE` on Linux, `renamex_np` with `RENAME_SWAP` on macOS),
  so the package path names a complete package at every instant. Node has no
  API for that call. The update makes it through Node's FFI when the running
  Node has it (Node 26), and otherwise through `/usr/bin/osascript` on macOS
  or `/usr/bin/perl` on Linux x64 and arm64; the installer's default Node is
  24, so the external tools are the common route. The result is read from the
  two paths' device and inode numbers, never from an exit code, and the
  `package-swap` step names the route. An updater killed before the exchange
  leaves a directory in `releases/` holding only a link, which is not a
  release and is collected. When no exchange is available (another platform,
  no perl, a filesystem that refuses the call), the run still adopts with the
  two renames and says so in the step; only that fallback keeps the missing
  package path and its documented manual recovery. A failed second rename
  moves the directory back. The first version refused before any change when
  `releases/` is on another filesystem; under decision 8 that run takes the
  swap.
- **The plain swap.** A run that takes the swap without a publication journal
  (pnpm, Bun, npm when no journal is prepared, and the in-place replacement of
  a service-bound release) moved the old package to its backup name, captured
  local overrides, and then moved the candidate in. Killed at any of six
  boundaries in between, it left the package path empty with no journal and no
  command able to run. [#200366](https://github.com/openclaw/openclaw/pull/200366)
  replays overrides while the old package still serves, gives the candidate
  the backup name, and publishes with the same exchange call adoption uses. The
  two names end as the moves would leave them, so rollback and retirement are
  unchanged. Without an exchange the two moves run and the step says so.
- **The journaled npm publication**, which a prefix the user manages takes on a
  normal update, moved the old package into the journal's `previous` name and
  later moved the candidate in. Killed at any of seven boundaries in between,
  it left the package path empty until the recovery command ran.
  [#200460](https://github.com/openclaw/openclaw/pull/200460) records the
  existing `publish` intent, gives the candidate the name `previous`, and
  exchanges that name with the package path. The result is the layout every
  recovery reader already expects after a publication. The one new state is
  the candidate waiting under `previous` beside the untouched installed
  package. The publication owner returns it to its own name before it
  classifies the layout, so a run killed there recovers to `aborted` with the
  old package installed. The old package is the build whose updater wrote the
  journal, which is why the candidate waits there instead of being exchanged
  under its own name. Local overrides are captured before publication. The
  journal's schema, version, and stored fields are unchanged. Without an
  exchange the two moves run, the step says so, and the window is two
  boundaries instead of seven.
  After a kill, measured in an installed package on Linux: the old package
  served, but the next `openclaw update` and `openclaw update repair` both
  exited 1 with `Package publication is incomplete`, and only the printed
  recovery command got out.
  [#200550](https://github.com/openclaw/openclaw/pull/200550) lets the next
  update or repair resume the killed publication itself. It runs the printed
  command's own recovery under a claim in the recorded lease store, which is
  what proves the original updater gone. It keeps an installed previous
  package and aborts, or publishes the recorded candidate when no package is
  installed. It still refuses for a live updater or helper, a removed or
  replaced lease store (a reboot), an edited package, a relinked launcher, a
  rollback in progress, and a helper sealed by another build.
  After that settlement the same update used to stop at a second check,
  `Update <id> has unfinished recovery`, until one `openclaw update repair`
  ran. [#200680](https://github.com/openclaw/openclaw/pull/200680) lets the
  next command-line update settle the killed update's plugin recovery itself
  with repair's settlement. It does so only when the update lease store still
  holds the dead updater's lease, its recorded process is gone, it did not
  leave the Gateway stopped, and the outcome is a rollback onto the
  still-installed previous version or keeping a verified candidate. As merged,
  it refused and named `openclaw update repair` for an installed version that
  was not verified, a rollback the killed update had already begun, a stopped
  Gateway, an update the Gateway started, a lost lease store, and a source
  checkout. The next bullet covers the changes that took over all of those
  except an update the Gateway started.
- **Finishing a killed update.** Three later changes settle more of what a
  killed update leaves, each keeping every proof #200680 requires.
  - **An installed version that was not finished.**
    [#200866](https://github.com/openclaw/openclaw/pull/200866) runs repair's
    finalization as a stage, `finishInterruptedUpdate` in
    `update-command-finalize.ts`: Doctor for the installed version, plugin
    convergence, and Gateway restoration. It covers three states: a candidate
    installed and not confirmed finished, a rollback the killed update had
    begun on the version it installed, and a Gateway the killed update stopped
    and never started. The last applies only when this update would restart
    the Gateway anyway. The stage has to run before target resolution, because
    it rewrites config that resolution reads, and the update's own run does
    not exist yet at that point. So the stage records the same repair-shaped
    run repair would (its `finalize:repair-continuation` step), and the
    update's run gets an `interrupted-update-finalization` warning step that
    names it. When the stage fails, Doctor maintenance has to wait, or the
    Gateway stays stopped, the update stops and names repair. It also refuses
    when other update history still owes recovery, because repair would finish
    that too.
  - **A lease store emptied by a restart.** The lease row is what showed the
    dead updater's processes gone, and a machine restart removes it.
    [#200994](https://github.com/openclaw/openclaw/pull/200994) records the
    boot each driver ran in as `origin.driver.namespace`, and on each
    `origin.previousDrivers` entry: platform, kernel boot ID, Linux PID
    namespace, and a digest of the machine identity. When the row is gone, the
    next update settles the run only if every recorded driver ran on this
    host, with the same non-null machine identity and platform, in a different
    boot; the platform is Linux or macOS, and on Linux the driver and this
    process are both in the initial PID namespace; and the run's last write
    predates the current boot. A run with a managed handoff or an unrecorded
    driver identity keeps the refusal. The key is optional JSON in
    `origin_json`. Older readers drop it, and the public run record strips it.
  - **A source checkout.** A checkout's version does not show whether a killed
    update had already swapped in its build.
    [#201009](https://github.com/openclaw/openclaw/pull/201009) has an
    in-place checkout update record the commit and build it activated, as
    `origin.gitActivation`, before it reserves its plugin recovery. The next
    update settles it like a package install only when the recorded builds
    match the plugin recovery, the checkout is still at that commit with no
    local changes (untracked files included), and its build is complete, made
    from that commit, and the recorded build. Otherwise it refuses and names
    which of those failed. After a restart both proofs must hold: the restart
    rule shows the processes gone, and the checkout checks run again under the
    installation claim. Package-to-Git conversion never records the field, and
    the Git release layout never reserves plugin recovery, so neither changes.
  - **Still by hand.** `openclaw update repair` is still needed for an update
    the Gateway started or a managed helper adopted; an updater that may still
    be alive, or whose exit was not observed; another installation's recovery;
    a dry run; a stopped Gateway under `--no-restart`; other update history
    that still owes recovery; a missing lease row without the restart proof,
    which covers Windows, containers, and runs recorded by older versions; and
    a checkout whose run has no `origin.gitActivation` or that was changed by
    hand. A run that a published updater left gets neither the restart rule
    nor the checkout rule, because that updater did not record the new
    fields.
  - **Measured.** The `package-installed-recovery` Docker lane now kills an
    updater after activation in every cut, leaving the candidate installed
    and its run `running`, and a plain `openclaw update --no-restart` follows
    with no repair. Under Docker Desktop on macOS, six of seven cuts passed.
    `partial-previous` passed its harness and then failed an access-reader
    check that cannot pass on that host and failed the same way before the
    change. The lane has no Gateway service and never reaches a begun
    rollback, so those two states ran only in process tests with a fixture
    service. No Linux host ran the lane. #200994 and #201009 ran in process
    tests from real updater children killed with SIGKILL; they replaced the
    lease store and the boot identity instead of restarting a host, and no
    killed source update was traced from the shipped CLI. A cloned machine
    that shares the host name, machine identity, and state directory is
    refused only by the last-write check, read from source, not run.
- **Local overrides** replay into the candidate release before the link names
  it, so a selected release is still written once.
- **Leases.** A Gateway writes `releases/.leases/<release>/<pid>-<start>-<n>`
  when it starts from a selected release and removes it when it stops; a
  dead process's lease is ignored. Other processes rely on the minimum age.
  The age counts from the release directory's modification time, which the
  switch stamps on the release it deselects, so a release deselected a
  minute ago is kept for a day whatever its install date.
- **Collection** runs after a verified forward update, from the updater, and
  keeps the two releases the current run names. A collected release is first
  renamed out of the release namespace, so a partial removal is never a
  release.
- **Not changed:** `openclaw gateway install --force` replacing the durable
  copy still swaps a directory over the link, like a manual `npm install -g`;
  the next update adopts again. The node host's own collection and the
  `activation.lock` liveness rule named in slice 4 are left for a follow-up.

### Route 4: package-manager-owned installations

Installations owned by pnpm, Bun, Homebrew, or a system package manager keep
their current update path.

An npm-owned global prefix could take a linked root without moving. In a test
with a toy package on npm 11.20.0, `npm install -g` over a linked root replaced
the link with a normal directory and left the release untouched, and
`npm uninstall -g` removed only the link. That means a manual npm install would
return the installation to today's layout, and the next update would adopt it
again. This is a separate proposal, after route 3 has run on owned prefixes.

### What was tested

The first two tests used toy packages. The third used published OpenClaw
releases in Docker.

- **Node 26.12.1.** A process started through the linked root kept loading its
  own release after the link was flipped under it. A process started afterwards
  loaded the new release. A plugin whose `node_modules/openclaw` named the
  stable path shared the host's module instance in both.
- **A plugin loaded by the old process after the flip** still resolved to the
  old release. Node's internal path cache explains that, and it is not a
  contract to rely on.
- **npm 11.20.0.** The behavior described under route 4.
- **Published drivers on a linked root.** In the published-driver update cell
  on linux/arm64, the installed release was moved into `releases/<version>/`
  and a relative link was left at the package path. `2026.10.9` and `2026.11.3`
  each updated to a build of `089d8b8`. The run finished, `readyz` returned 200,
  the running version matched, and the durable and incognito session checks
  passed. Afterwards the link was unchanged and its target directory held the
  new build. The cell's installed-tree budget check refuses a linked root, so
  it was pointed at the link's target for these runs.

## Part B: move update work to the candidate in stages

### B1: the candidate rehearses itself (merged)

After staging, the updater runs the candidate's hidden
`openclaw update rehearse --request <file>` in place of its own rehearsal when
the target declares `openclaw.updateRehearsalProtocol`. The candidate receives
the resolved config source in a private file, holds no update authority, and
touches copied state only. See [Update](/cli/update) once it lands.

Review of that slice produced four rules that every later handoff should keep:

- **Committed progress before forward work.** The candidate waits for the
  updater's answer to each receipt before it continues, so no check starts or
  completes ahead of a recorded step.
- **Custody of child processes.** Each check runs in its own process group. The
  candidate reports them, and the updater stops any left running, after
  confirming the process still has the start time it had when reported.
- **Inconclusive is not a refusal.** A timed-out check or a failed state copy
  returns no verdict, and the updater runs its own rehearsal. Only a failed
  Doctor rehearsal or private Gateway refuses.
- **A visible outcome.** The update output says when the candidate ran its own
  checks, and names the reason when the updater took them back.

### B2: after the commit point, steps are owed

Live Doctor, post-core convergence, and migrated finalization already run in
candidate code. In those phases, a failure of an independent step is recorded
as owed with its reason, and the next Gateway start or `openclaw update`
retries it: plugin convergence, service definition refresh, shell completion,
and collection. Required migrations, refused config writes, and readiness stay
blocking.

#### First slice as built

[#200331](https://github.com/openclaw/openclaw/pull/200331) adds the contract
and its first two steps, a shell completion refresh and a Gateway service
definition refresh.

- **The row.** An owed step is a `finalize:owed:<id>` step in the run's
  existing `steps` JSON: status `skipped` while owed, `completed` once settled,
  the reason in `detail`. It uses no new field, status, or schema, so published
  readers accept it. The ids are a closed set in one module.
- **Who decides.** The newest of the last 50 runs that mentions a step decides
  whether it is owed. Failed and rolled-back runs neither owe nor decide. A
  run that still owes a step an earlier run recorded writes its own row and
  leaves the earlier one alone, so the earlier run owes the step again if the
  later run fails. The first version settled the earlier row on takeover and
  lost the step in that case.
- **Finished runs.** Only the owed-step writers may write to a finished run
  that kept its result. Every other writer still treats finished runs as
  immutable.
- **Retry.** The next `openclaw update` retries, also when the core is already
  current, and `openclaw update repair` settles after its own finalization. A
  retry that fails keeps the step owed, warns, and never fails its command.
  Gateway startup does not retry; this differs from the paragraph above
  because startup runs no package manager and the two first steps need none
  of its state.
- **Reporting.** The update's report, `openclaw update status`, and the JSON
  field `owedSteps` name the step, its reason, and what settles it. The
  finalize child's `status` does not change for an owed step, because a
  parent updater, including a published one, reads it as the plugin and
  Doctor outcome.
- **First hop.** The installed updater finishes the first update to a release
  with this change, so nothing is recorded on that run unless the update
  migrated state and the candidate finishes it.

#### Second slice as built

[#200507](https://github.com/openclaw/openclaw/pull/200507) adds two steps,
`plugin-convergence` and `post-plugin-doctor`. Before it, either failure
rolled a replaced core back.

- **Plugin convergence is owed only when the previous plugin set stands.**
  That needs a plugin cohort whose rollback succeeded, a throw before any
  record or config was published, and no channel config that only this
  update can restore. A refused config write, a Doctor refusal, lost
  authority, pending recovery, and a child whose exit is unconfirmed still
  fail the update.
- **Where it is not owed.** On an already-current core and in
  `openclaw update repair`, plugin installs commit one by one, so a throw
  there still fails the command and the step stays owed. This narrows the
  "never fails its command" rule above for this one step.
- **Post-plugin Doctor is owed only after Doctor started** and when the
  failure carries no fact from Doctor itself. A Doctor process that exits
  nonzero was already a warning. A missing entrypoint, a Gateway that could
  not be parked, a migration or config refusal, and data at risk stay
  blocking. Config validation and readiness still run and still decide
  whether the Gateway starts.
- **When the row is written.** Plugin work runs before activation, so the
  row is written in post-update maintenance, after the Gateway is verified. A
  failed or rolled-back run records nothing.
- **Settling.** A later plugin phase settles an owed step only when its own
  convergence completed. A phase deferred because config changed settles
  nothing. The Doctor step also needs a full Doctor run after plugins changed.
- **First hop.** Released updaters through 2026.11.5-beta.4 retain no plugin
  cohort, so the first update from them gains nothing: the new child still
  fails and the old parent rolls back. This is read from source, not run.

#### What else can still fail a kept update

An inventory of every step after the verification point, read at
`ae31ea3be6d`, found most of them already warnings or owed steps. The rest
fall into three groups.

- **Fixed as a warning.** After a switch from a Git checkout to a package
  install, an old `openclaw` wrapper that could not be removed failed the
  update and rolled the package back unless a restart had been verified.
  [#200579](https://github.com/openclaw/openclaw/pull/200579) keeps the
  package and warns. It is not an owed step: the run record has no field for
  the wrapper path, and a recheck over `PATH` both settles falsely and stays
  owed forever, because the installer writes the same wrapper template in
  other places. A wrapper owned by a system package still fails the update.
- **Blocking on purpose.** Service revalidation and the second restart after
  deferred plugin convergence, plugin cohort commit, Windows autostart
  restore, and the terminal record and ledger finish protect authority,
  readiness, cohort settlement, or state only this run can restore.
- **Measured.** A previous npm link that cannot be removed is now a warning
  ([#200613](https://github.com/openclaw/openclaw/pull/200613)); a link that
  was replaced or cannot be read still fails the update. Release collection
  was already a warning. A non-errno throw in the Git runtime backup only
  arises from lost authority or an unconfirmed child, and stays blocking.

### B3: stop, publish, and rollback authority

Not designed here. Three things block it:

- Executor grants are bound to live parent PIDs.
- The rollback capture holds closures in the updater process.
- The managed-service handoff lease transfers to a helper running the installed
  entry point, not the candidate, and it is not available on Windows.

A linked root makes rollback a serializable record, the identity of the
previous release, which removes the second blocker.

## Update behavior and first hop

| Hop or case                                    | What happens                                                                                                      | Proof                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Any published driver to a B1 release           | Unchanged. The old driver runs its own rehearsal.                                                                 | Ran on #197922 at `758582e`: `2026.10.1`, `2026.10.9`, `2026.11.2`, `2026.11.3`.                                   |
| B1 driver to a B1 candidate                    | The candidate rehearses itself.                                                                                   | Ran: a local build seeded as the driver, passed.                                                                   |
| B1 driver to a candidate without marker        | The updater runs its own rehearsal.                                                                               | Unit tests only.                                                                                                   |
| Published driver to the first route 3 release  | Today's swap. The package root stays a plain directory.                                                           | New: a published-driver cell.                                                                                      |
| Route 3 driver, package root still a directory | Adoption: the old tree becomes the previous release and the link takes its place.                                 | New: `install-cli.sh` prefix and durable service copy, then rollback.                                              |
| Route 3 driver, linked package root            | The flip.                                                                                                         | New: two consecutive updates, rollback, and a Gateway-initiated update.                                            |
| Published driver meets a linked package root   | It follows the link and swaps the new release into the directory behind it. The update passes and the link stays. | Ran by hand at `089d8b8`: `2026.10.9` and `2026.11.3`. Not yet a permanent cell.                                   |
| Killed around the flip                         | The link names the old or the new release. The next run compares it with the two identities in the run record.    | New: fault injection and a killed child process after the temporary link is made, and before and after the rename. |

This design does not repair an updater that is already installed. An
installation on an older release reaches a B1 or route 3 release with the
updater it has, and adopts the linked layout on the update after that.
Installations already blocked on a published driver still need their documented
manual procedure once.

A published driver can meet a linked root after a downgrade to a release from
before route 3. That cell ran, and it does not strand the installation: the
update finishes, the Gateway is ready, and sessions survive.

It also does not do what the previous version of this page predicted. The
driver resolves the link, then stages and swaps inside the release directory.
The link is unchanged, and the directory that held the old release now holds
the new one. The driver also leaves its activation control directory beside the
package in that release's `lib/node_modules`.

Route 3 therefore cannot treat a release directory as sealed, or read a
release's identity from its directory name. See "Release identity" under
[route 3](#route-3-recommended-a-linked-package-root).

## Channels and downgrades

Stable, beta, and extended-stable differ only in how the target is selected,
and target selection stays in the installed updater. All three get B1 and B2,
and route 3 only on an owned prefix.

Dev is a Git installation. The installed updater must fetch, replay local
commits, install dependencies, and build before any candidate code exists. B1
applies after that build. Route 3 does not apply.

`openclaw update --tag <older-version>` keeps its contract: it checks that the
target can read current state, asks for confirmation, and refuses a target
behind a migration. On a linked root an allowed downgrade points the link at an
older release, with no download when that release is still retained. See
[Downgrade](/install/updating/rollback-and-recovery#downgrade).

## Risks

| Risk                                                     | Severity | Mitigation                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Something stores a resolved release path                 | High     | Known holders are plugin links, the agent CLI shim, executor and journal identity, and a service definition written by a published updater through the link (observed; the update replaces that release in place and the restart rebinds it, decision 8). |
| Collection deletes a release in use                      | High     | Leases, not a newest-N rule. An unknown reference keeps the files.                                                                                                                                                                                        |
| A published driver rewrites a release directory in place | High     | Seen in the linked-root cell. Identify a release by its recorded content identity, never by directory name, and adopt again when the content changed.                                                                                                     |
| The Windows flip is two renames                          | Medium   | The Gateway is stopped, the exposure equals today's swap, and the node host's `.previous` recovery applies.                                                                                                                                               |
| A process keeps running across a flip                    | Medium   | It stays in its own release, which is safer than today. Its lease keeps that release from collection.                                                                                                                                                     |
| npm reports the package as a link on an owned prefix     | Medium   | Document it. A manual `npm install -g` restores a plain directory, and the next update adopts it again.                                                                                                                                                   |
| Several Gateways share one owned prefix                  | Medium   | One flip moves all of them. Each is drained and stopped, and each state directory gets its own Doctor run.                                                                                                                                                |
| Disk use                                                 | Medium   | A release measured 591 MB. Bounded by leases and minimum age. Admission checks free space for the candidate.                                                                                                                                              |
| Nothing in the updater holds the link path               | High     | Root discovery resolves to the release directory. Build the slot resolver first, and land target resolution and the switch together.                                                                                                                      |

## Review slices

These are proposals, not permission to open them.

1. **B1, candidate-owned rehearsal.** Merged as #197922.
2. **Linked-root readiness, no layout change.** A published-driver cell with a
   linked root, in review as #198489, and the recorded design for the switch.
   Nothing an existing installation can observe.
3. **A shared release installer, folded into slice 4.** The step runner the node
   host and `openclaw update` share already exists
   (`runGlobalPackageUpdateSteps`). The missing piece, installing a verified
   release into a private prefix, has no second caller until slice 4, so it
   lands there instead of as a refactor with one caller.
4. **Adoption and the switch on the `install-cli.sh` prefix and the durable
   service copy.** The slot resolver and the link lifecycle (capture, switch,
   verify, sweep) land here with their first caller, so no unused code reaches
   `main` ahead of it. `resolveOpenClawInstallationRootSync` already recovers
   the stable path for the Gateway and is the owner to extend; it misses a
   start through the `bin` launcher. With them come the run record field,
   interrupted handoff reading through the link, and target resolution wired
   together with the switch, which is the first change an installation can
   observe. When the candidate's launcher text differs from the installed
   one, the run takes the swap instead of the switch. Release identity, rollback,
   leases, and collection. This slice also gives the node host its missing
   collection and a liveness rule for `activation.lock`.
5. **Retire what a linked root makes unnecessary,** after measuring: the
   baseline fingerprint, the backup, and the updater's runtime copy.
6. **B2, owed steps.**
7. **Measure, then prepare on discovery and skip rehearsal on equal schemas.**

B3, route 4, and Windows each need their own proposal.

## Decisions

A maintainer accepted answers 1 to 7 on November 13, 2026, and gave answer 8
on November 15, 2026.

| #   | Decision                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                        | Still open                                                                   |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Whether owned prefixes switch releases through a linked package root.      | Yes, over rebinding and over the immutable owner, for the reasons under routes 1 and 2.                                                                                                                                                                                                                                                                                                       | Adoption waits on the design answering what the published-driver cell found. |
| 2   | Whether the activation journal records a pointer intent for a linked root. | No. Revised the same day on the recommendation of a design pass: the link is the record, and the update run record carries the two release identities. See [recording the switch](#recording-the-switch).                                                                                                                                                                                     | Show that a published reader drops the new optional field.                   |
| 3   | The retention rule for release directories.                                | Leases plus a minimum age of 24 hours, as Hermes uses. The age covers a process that has started from a release but not yet taken its lease.                                                                                                                                                                                                                                                  | None.                                                                        |
| 4   | Where release directories live for the durable service copy.               | Inside the prefix, at `<stateDir>/npm/releases/`. Backups already exclude `<stateDir>/npm` as managed state (`MANAGED_STATE_ROOTS` in `backup-resource-inventory.ts`). Plugin installs share the prefix but live under `projects/`, and plugin discovery and Doctor walk only the prefix root and `projects/`. A directory beside the prefix would have to be added to the backup exclusions. | None.                                                                        |
| 5   | Whether to accept the B1 package marker.                                   | Yes. It ships with #197922.                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                        |
| 6   | Whether npm-owned global prefixes take a linked root.                      | Not now. It needs its own proposal.                                                                                                                                                                                                                                                                                                                                                           | That proposal.                                                               |
| 7   | Whether equal schema versions are enough to skip the state rehearsal.      | Yes for the snapshot and migration rehearsal; no for config validation and plugin planning.                                                                                                                                                                                                                                                                                                   | None.                                                                        |
| 8   | Whether a condition that prevents the link switch may fail the update.     | No. The run takes the swap, or replaces a service-bound release in place, with a recorded warning. See [the layout never fails an update](#the-layout-never-fails-an-update).                                                                                                                                                                                                                 | None. Landed in #198835.                                                     |

## Not doing

- No launcher or selector logic in the npm package.
- No rewriting of the service definition, wrapper, or installer layout to
  switch releases.
- No extension of the immutable installation owner to user installations.
- No change to how the packaged macOS app, pnpm, Bun, Homebrew, system package
  manager, container, or Windows Bun installations are updated or refused.
- No two-Gateway blue-green cutover.
- No new `openclaw.json` options.
- No change to schema policy, Doctor migrations, or the rule that code does not
  roll back across a migration.
- No attempt to shorten Gateway startup, drain, or Doctor.

## Rejected approaches

**A launcher in the npm package (first version).** It kept the npm-installed
package as a launcher that read a `current` selector. The Gateway service and
both installer wrappers bypass `openclaw.mjs`, and two copies of the code would
report different versions.

**Extending the immutable owner to user installations (second version).** See
route 1. Its guarantees come from separate accounts, source builds, and
system-scope systemd, and it cannot cross a migration.

**Rebinding the installation to a new package root (third version).** See
route 2. It rested on a wrong premise: that a pointer needs launcher code to
keep a process inside one release. Node does that itself by resolving the entry
file's real path, and the service definition already stores the stable path.

**Describing Part B as relocating an existing handoff (first version).** No
existing handoff carries stop, publish, or rollback authority.

## Evidence limits

- Route 3 has run only in the published-driver Docker cell on linux/arm64, from
  [#198835](https://github.com/openclaw/openclaw/pull/198835): adoption of an `install-cli.sh`-shaped prefix and a switch,
  a second switch, rollback after a post-switch Doctor failure, and the
  refusal of a service bound to a release path after published `2026.10.9`
  updated a linked root. Not run: the durable service copy, launchd, a
  Gateway-initiated update, APFS, and a published reader of the new run
  record (published `2026.11.3` cannot open state this candidate migrated;
  its `origin` schema is a plain `z.object`, which drops the key).
- The adoption exchange ran on macOS arm64 and in linux/arm64 containers, with
  the updater killed at every file system boundary. Not confirmed: native x64, an
  installation made by `install-cli.sh`, and `osascript` under launchd.
- The plain-swap exchange ran through a kill at every boundary on macOS arm64,
  and once in the in-place Docker cell on linux/arm64 with published
  `2026.10.9`. pnpm and Bun ran through fixtures only. The journaled exchange
  ran through a kill at every boundary on macOS arm64 through `osascript`, and
  once to completion in the published-driver launcher cell on Linux through
  `perl`. Not run: a kill around the exchange on Linux, power loss, and an
  older release executed against the waiting state. Owed steps ran through
  the update command with fixture services; no published-driver cell, live
  shell, launchd, systemd, or Windows service exercised them. The owed
  plugin steps used a real ledger, cohort, package directory, and config
  with a simulated service manager and Gateway; no managed npm install ran
  under a cohort.
- Finishing a killed update ran installed only for a candidate left
  unconfirmed, under Docker Desktop on macOS with no Gateway service. Not run
  installed: a begun rollback, a stopped Gateway, a Linux host, a real host
  restart, and a killed source checkout update from the shipped CLI.
- The source trace read code and ran nothing. Not read: the launchd, systemd,
  and Task Scheduler writers, how the plugin loader enforces quarantine, the
  restart sentinel, and every use of the updater's retained runtime.
- The linked-root cell covered two published drivers on Linux, one update each.
  Not covered: rollback after a failed update on a linked root, a second
  update, a Gateway-initiated update, older drivers, and Windows. The service
  definition's path was not captured.
- The timings come from one Docker run on a small fixture state, and the split
  of the swap step is partly inferred.
- How many installations use each layout is unknown.
- B1 has not run on Windows or under launchd, and against no extended-stable
  driver. Published `2026.9.9` fails to finish an update to `a83f74375ccaa`
  with or without #197922, for a reason not yet established.
- Pi and Hermes were read from their main branches on November 12, 2026, Codex
  from a checkout dated August 30, 2026, and Claude Code from its documentation.

## Related

- [Team immutable update design](/reference/team-immutable-update-design)
- [Update](/cli/update)
- [How an update runs](/cli/update/how-updates-run)
- [Automatic updates](/install/updating/automatic-updates)
