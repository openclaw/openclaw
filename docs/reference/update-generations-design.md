---
doc-schema-version: 1
title: "Update generations design"
summary: "Design proposal: package generations on OpenClaw-owned prefixes inside the package update path, and staged transfer of update work to the candidate"
read_when:
  - Designing how OpenClaw-owned install prefixes replace their code during an update
  - Deciding whether a user-scope installation should reuse the immutable installation owner
  - Reviewing which update steps run in the installed updater and which run in the candidate
---

# Update generations design

**Design proposal. One slice is implemented and in review; nothing else here is built. No implementation authorization.**
Two changes to `openclaw update`: install each release into its own directory
on prefixes that OpenClaw owns, and move update work out of the installed
updater into the candidate in stages.

This is the third version. Source reviews at
`0001c18108e9f13426bbc9eaedd656e4bd86cef6` and
`96a52f29220a8` on November 12, 2026 changed the plan twice. See
[Rejected approaches](#rejected-approaches). Counts under "Why change it" are
from `6acf398088c430ba93944a5bc07eec1b2299ac00`.

| Slice                                        | Status                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Candidate-owned rehearsal                    | Implemented in [#197922](https://github.com/openclaw/openclaw/pull/197922), draft. |
| Package generations on owned prefixes        | Proposed below. Needs decisions 1 to 4.                                            |
| Owed steps after the commit point            | Proposed.                                                                          |
| Stop, publish, and rollback in the candidate | Not designed.                                                                      |

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

**Package updates replace files in place.** The old bytes are gone after the
swap, so the updater backs them up, fingerprints both trees, saves and restores
launchers, and keeps a private copy of its own runtime so it can finish.

**The installed updater drives the whole run.** A fix in the new release cannot
help the release that is failing, which is why `2026.9.3` through `2026.9.5`
each carry a manual procedure.

### Measured

Two runs of the published-driver Docker cell on November 12, 2026, with a small
fixture state. Treat the proportions as indicative.

| Step                            | Published updater | Updater with #197922 |
| ------------------------------- | ----------------- | -------------------- |
| Package swap                    | 41.4 s            | not extracted        |
| Updater copying its own runtime | 15.8 s            | not extracted        |
| Package install into staging    | 19.6 s            | not extracted        |
| Rehearsal, all checks           | 24.3 s            | 25.5 s               |
| All recorded steps              | 154 s             | 177 s                |

In the first run the package swap and the updater's self-copy were 37% of
recorded step time. Generations remove both on the prefixes they cover.

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

## Installation layouts today

| Layout                        | Who owns it                                                                                                                                                              | Source                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `install.sh`, the default     | npm. It runs `npm install -g` into the user's npm prefix.                                                                                                                | `scripts/install.sh`                             |
| `install-cli.sh`              | OpenClaw. Default prefix `~/.openclaw`. `tools/node-v<version>/` is both the private Node and the npm prefix. `bin/openclaw` is a wrapper that names one physical entry. | `scripts/install-cli.sh`                         |
| macOS app managed CLI         | OpenClaw. The app runs the bundled `install-cli.sh` with the profile state directory as the prefix.                                                                      | `apps/macos/Sources/OpenClaw/CLIInstaller.swift` |
| Durable service copy          | OpenClaw. An npm prefix at `<stateDir>/npm` that `openclaw update` updates in place.                                                                                     | `src/daemon/durable-service-entrypoint.ts`       |
| Node host runtime generations | OpenClaw. `<stateDir>/node-runtime/releases/<version>-<digest>`, each a private npm prefix.                                                                              | `node-host-launcher.mjs`, `src/node-host/`       |
| Immutable installation        | OpenClaw, root-owned, after explicit adoption.                                                                                                                           | `src/infra/update-immutable-*.ts`                |

Two facts constrain any release-directory design:

- The Gateway service definition runs the package's `dist/index.js` by absolute
  path (`resolveGatewayProgramArguments` in `src/daemon/program-args.ts`).
- A managed plugin that declares `openclaw` as a peer dependency gets
  `node_modules/openclaw` linked to the real path of the host package
  (`src/plugins/plugin-peer-link.ts`). Doctor and plugin install or update
  create those links.

Switching releases therefore means rewriting the service definition and
relinking plugins, not only moving a pointer.

## Part A: release directories

Three routes were evaluated.

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

The owner's safety rests on privilege separation. With one account, what
transfers is the pattern, not the owner: journaled pointer publication
(`package-update-activation-immutable-pointer.ts`), the activation journal, and
the rule that Node starts from a physical path so lazy imports stay in one
generation.

**Verdict: do not extend the immutable owner to user installations.** Reuse
those three pieces.

### Route 2, recommended: package generations inside the package update path

The package update path already runs on every platform, crosses migrations
through Doctor, refreshes service definitions, and tracks an active package
root separately from the original one (`activePackageRoot` in
`src/infra/package-update-steps.ts`). The change is to its publication step:
bind the installation to a new package root instead of swapping bytes under the
old one.

```text
<owned prefix>/
  bin/openclaw            wrapper written by OpenClaw; names one physical entry
  tools/node/             private Node
  releases/
    2026.11.4-3f9c.../    private npm prefix, sealed after install
    2026.12.1-a01b.../
```

**A generation is a private npm prefix.** `prepareNodeRuntimeUpdate` in
`src/node-host/auto-update-install.ts` already builds one: it reads the registry
manifest, checks the tarball's sha512 integrity, and installs through the
shared `runGlobalPackageUpdateSteps`. Lift its generic part into one shared
owner and make the node host a caller that supplies its schema checks.

**There is no pointer file.** The wrapper and the service definition each name a
physical entry, and both are rewritten at activation. Node therefore always
starts from a physical path, and no launcher logic is added to the package.

**Activation is a rebinding, journaled as one operation:**

1. Rewrite the service definition to the new package root. The update path
   already rewrites definitions during finalization.
2. Rewrite the wrapper by writing a temporary file and renaming it.
3. Relink managed plugins to the new host package, through the existing plugin
   link owner.

The journal records intent before the first effect and the observed result
after each. Rollback reverses the same three effects. Migration, backups, drain,
stop, start, and verification stay exactly as the package path does them today,
which is why this route can cross schemas and the immutable one cannot.

**Layout conflicts to resolve first:**

- `install-cli.sh` nests the package under a versioned Node directory, so the
  Node version and the release are one directory. They must separate.
- The macOS app uses the profile state directory as the prefix, so `releases/`
  would sit inside state. It needs a data location outside state, or an
  explicit carve-out from state backups and Doctor's replacement set.
- The durable service copy enters through `openclaw.mjs`, not a wrapper. Its
  selector is the service definition alone.
- Shell, TypeScript, and Swift each hard-code these paths. One owner must
  publish the layout, and the others must read it.
- `install-cli.sh` has no Windows path.

**Retention.** Each process holds a lease on the release it runs. Collection
removes a release only when no wrapper or service definition names it, no lease
holds it, the journal does not reference it, and it is past a minimum age. A
release that sits behind a completed migration is collected once the migrated
Gateway verifies.

**What it retires, on owned prefixes only:** the live-tree backup, baseline
fingerprinting, rollback byte verification, and the updater's private copy of
its own runtime. The swap code stays, because it builds each generation and
serves package-manager-owned installations.

### Route 3: move package-manager-owned installations to an owned prefix

Installations owned by npm, pnpm, Bun, Homebrew, or a system package manager
gain nothing from route 2 unless they move. If offered, the move follows Pi's
order: prepare and verify the owned release, switch the service and PATH entry,
and only then remove the package-manager copy. This is a separate proposal,
after route 2 has run on owned prefixes.

## Part B: move update work to the candidate in stages

### B1: the candidate rehearses itself (implemented, in review)

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

### B3: stop, publish, and rollback authority

Not designed here. Three things block it:

- Executor grants are bound to live parent PIDs.
- The rollback capture holds closures in the updater process.
- The managed-service handoff lease transfers to a helper running the installed
  entry point, not the candidate, and it is not available on Windows.

Route 2 makes rollback a serializable record, which removes the second blocker.

## Update behavior and first hop

| Hop or case                             | What happens                                                                                                               | Proof                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Any published driver to a B1 release    | Unchanged. The old driver runs its own rehearsal.                                                                          | Ran: published `2026.11.3` to #197922, passed.                   |
| B1 driver to a B1 candidate             | The candidate rehearses itself.                                                                                            | Ran: a local build seeded as the driver, passed.                 |
| B1 driver to a candidate without marker | The updater runs its own rehearsal.                                                                                        | Unit tests only.                                                 |
| Owned prefix, first generation update   | The driver prepares the first release directory. Activation rebinds the service definition, the wrapper, and plugin links. | New: `install-cli.sh` prefix, two consecutive updates, rollback. |
| Killed at any rebinding effect          | Journal intent is reconciled against all three effects before retry.                                                       | New: fault injection before and after each effect.               |

This design does not repair an updater that is already installed. An
installation on an older release reaches a B1 release with the updater it has.
Installations already blocked on a published driver still need their documented
manual procedure once.

## Channels and downgrades

Stable, beta, and extended-stable differ only in how the target is selected,
and target selection stays in the installed updater. All three get B1 and B2,
and route 2 only on an owned prefix.

Dev is a Git installation. The installed updater must fetch, replay local
commits, install dependencies, and build before any candidate code exists. B1
applies after that build. Route 2 does not apply.

`openclaw update --tag <older-version>` keeps its contract: it checks that the
target can read current state, asks for confirmation, and refuses a target
behind a migration. On an owned prefix an allowed downgrade rebinds to an older
release, with no download when that release is still retained. See
[Downgrade](/install/updating/rollback-and-recovery#downgrade).

## Risks

| Risk                                             | Severity | Mitigation                                                                                                              |
| ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Rebinding leaves a mixed state                   | High     | Journal intent before the first effect and reconcile all three before any retry or start.                               |
| Collection deletes a release in use              | High     | Leases, not a newest-N rule. An unknown reference keeps the files.                                                      |
| Three owners hard-code the prefix layout         | High     | One owner publishes the layout. Converge the installer and the macOS app before any activation change.                  |
| `releases/` inside the state directory           | Medium   | Decide the macOS app's data location first. Do not let state backups or Doctor copy release directories.                |
| Several Gateways share one owned prefix          | Medium   | One activation rebinds all of them. Each is drained and stopped, and each state directory gets its own Doctor run.      |
| Disk use                                         | Medium   | Bounded by leases and minimum age. Admission checks free space for the candidate. Installed release size is unmeasured. |
| A new journal descriptor outlives its first form | Medium   | Version it. Retained recovery runtimes must be able to read it.                                                         |

## Review slices

These are proposals, not permission to open them.

1. **B1, candidate-owned rehearsal.** In review as #197922.
2. **One layout owner and a shared generation installer, no activation.**
   Separate the Node directory from the release directory in `install-cli.sh`,
   publish the layout from one owner, and make the node host a caller of the
   shared installer. `openclaw update status` reports prepared generations.
3. **Rebinding activation on the `install-cli.sh` prefix.** Journal descriptor,
   the three effects, rollback, and leases with collection. This slice also
   gives the node host its missing collection and a liveness rule for
   `activation.lock`.
4. **The macOS app and the durable service copy.**
5. **B2, owed steps.**
6. **Measure, then prepare on discovery and skip rehearsal on equal schemas.**

B3, route 3, and Windows support for owned prefixes each need their own
proposal.

## Decisions needed

| #   | Decision                                                                              | Suggested answer                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Whether package generations live in the package update path, not the immutable owner. | Yes, for the reasons under route 1.                                                                                                                  |
| 2   | Whether the activation journal takes a typed descriptor for rebinding.                | Yes, through the [storage design checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes). No second journal. |
| 3   | The retention rule for release directories.                                           | Leases plus a minimum age. A retention change is an approval this repository reserves.                                                               |
| 4   | Where the macOS app keeps release directories.                                        | Outside the profile state directory.                                                                                                                 |
| 5   | Whether to accept the B1 package marker.                                              | Yes. It is a protocol addition and an approval this repository reserves. Pending on #197922.                                                         |
| 6   | Whether to offer package-manager-owned installations a move to an owned prefix.       | Later, as its own proposal.                                                                                                                          |
| 7   | Whether equal schema versions are enough to skip the state rehearsal.                 | Yes for the snapshot and migration rehearsal; no for config validation and plugin planning.                                                          |

## Not doing

- No launcher or selector logic in the npm package.
- No extension of the immutable installation owner to user installations.
- No change to how npm, pnpm, Bun, Homebrew, system package manager, container,
  or Windows Bun installations are updated or refused.
- No two-Gateway blue-green cutover.
- No new `openclaw.json` options.
- No change to schema policy, Doctor migrations, or the rule that code does not
  roll back across a migration.
- No attempt to shorten Gateway startup or drain.

## Rejected approaches

**A launcher in the npm package (first version).** It kept the npm-installed
package as a launcher that read a `current` selector. The Gateway service and
both installer wrappers bypass `openclaw.mjs`, service definitions and plugin
links hold physical paths, and two copies of the code would report different
versions.

**Extending the immutable owner to user installations (considered for this
version).** See route 1. Its guarantees come from separate accounts, source
builds, and system-scope systemd, and it cannot cross a migration.

**Describing Part B as relocating an existing handoff (first version).** No
existing handoff carries stop, publish, or rollback authority.

## Evidence limits

- Route 2 is designed from reading source. Not traced: how the update path
  rebinds a service to a different package root end to end, whether Gateway
  startup repairs stale plugin links, shell completion's use of the package
  root, and the Windows wrapper.
- The timings come from two Docker runs on a small fixture state.
- How many installations use each layout is unknown.
- B1 has not run on Windows or under launchd, and against only one published
  driver.
- Pi and Hermes were read from their main branches on November 12, 2026, Codex
  from a checkout dated August 30, 2026, and Claude Code from its documentation.

## Related

- [Team immutable update design](/reference/team-immutable-update-design)
- [Update](/cli/update)
- [How an update runs](/cli/update/how-updates-run)
- [Automatic updates](/install/updating/automatic-updates)
