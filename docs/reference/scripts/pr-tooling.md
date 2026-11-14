---
summary: "Canonical wrapper trust, process locks, and materialized dependencies for scripts/pr"
read_when:
  - Changing PR wrapper supervision, locks, dependency materialization, or tooling-root selection
title: "PR wrapper tooling"
---

# PR wrapper tooling

## Finalized task closeout

Ordinary `scripts/pr gc [--pr <number>] [--dry-run]` discovers native `pr-*`
worktrees. To close an already-authorized, completed task with a custom worktree
name or root proof directories, select its exact resources:

```bash
scripts/pr gc --pr 123 --finalized-task <codex-thread-id> --expected-head <full-head-sha> \
  --worktree .worktrees/task-123 \
  --artifact .worktrees/task-123/.artifacts \
  --artifact .worktrees/task-123/node_modules \
  --artifact .artifacts/task-123-proof --dry-run
```

Re-inventory and establish task ownership before selecting resources. Inspect the
dry-run, then repeat without `--dry-run`. Finalization is the owning task's explicit
declaration, not another operator approval. Paths are relative to the physical
canonical repository root or absolute. Worktrees must be immediate children of
`.worktrees`; artifacts must be directories or symlinks below that selected
worktree or the canonical `.artifacts` directory. Select each independently; omit
`--worktree` for artifact-only closeout. Symlink targets, unrelated resources,
credential directories, and shared dependency consumers are preserved. Unselected
ignored or untracked entries prevent worktree removal.

The landing-class wrapper and existing PR operation/removal owners remain in
charge. The command verifies repository identity, merged PR state, exact PR and
worktree HEAD, physical boundaries, Git metadata, process holders, session
references, and unresolved native operations. It reads metadata from the existing
Codex daemon. Add `--known-thread <id>` for additional known sessions or select
`--codex-socket <path>` for an independent daemon; unavailable known owners block
removal. This does not claim a complete host-wide census. Native managed worktrees
must use their managing owner's removal path.

Dry-run does not acquire/recover an operation lock or delete files. Execution
rechecks relevant conditions, reports removed/already absent resources, and safely
retries partially completed selections. Branches and remote resources are
untouched. External merges need no synthetic receipt; existing native recovery
evidence and uncertain operations still require their normal recovery route.
See the [merge recovery contract](/reference/scripts/merge-recovery).

## Wrapper execution and dependencies

- Supervised PR operations disable automatic Git maintenance through inherited process configuration, preserving repository settings. Explicit maintenance must still join before completion. PR source fetches also disable automatic maintenance: fetching one PR does not authorize repository-wide pruning of unrelated worktree metadata.

- `scripts/pr` serializes review, prepare, and merge operations per PR across linked worktrees; `scripts/pr gc` skips active or indeterminate locks. Its subcommand classification table is the canonical wrapper trust boundary: a mismatched local wrapper may run only a classified `advisory` subcommand with `--dev-wrapper` or `OPENCLAW_PR_DEV_WRAPPER=1`; classified `landing` subcommands always require canonical/origin-main wrapper code. A worktree whose wrapper differs from origin/main (stale base or wrapper-editing branch) loudly substitutes the canonical checkout's wrapper when that checkout is clean and byte-identical to fetched `refs/remotes/origin/main`; it refuses only when no anchor-matching wrapper is available. A successful command return is the trusted synchronous-completion contract: every PR-state-mutating child must be joined before returning, and such work must never daemonize or explicitly escape both the operation group and lock-notification FD. Release on clean exit requires the leader's completion marker; an escaped descendant that merely holds the notify pipe then produces a loud warned release instead of retention (#124583). A failed command auto-releases while its explicit pre-side-effect validation marker remains active, or after side effects when it exits on its own (status 1-127, no signal) and the full drain observes its group dead and every notification-pipe holder gone; that leaves only the fd-closing escapee residual a clean exit already accepts. Interruptions, lingering group work, a still-open pipe, and controller loss stay locked because detached children cannot be disproved. After verifying no child tools remain, use the reported exact-OID `scripts/pr lock-recover` command. Never bypass or delete these refs manually.
- Materialized wrappers pin selective third-party dependencies to their installed real package directories before handoff, not mutable top-level `node_modules` aliases. The anchored `pr-lib/materialize-dependencies.mjs` owns that set; the child completes it on handoff too, because an older parent may pin fewer packages. Reentry preserves already pinned installations. For anchors predating that helper, the parent performs the same setup against the extracted manifest; pre-#149585 anchors without a manifest retain their original four tooling dependencies. When installed packages are missing or differ from the anchored manifest, the current wrapper prepares the anchor’s own frozen installation before lock acquisition. It never installs into the canonical checkout, a selected tooling checkout, or another anchor’s installation; only selective third-party package directories are pinned. Keep the resolved package installation intact until the supervised command finishes; pinning paths does not copy or freeze package contents. `test/scripts/eager-import-closure.test.ts` checks archived eager imports against copied sources and pinned package exports; keep `pr-lib/wrapper-components.txt` current when that source closure changes. Run `pnpm test test/scripts/eager-import-closure.test.ts -t "PR wrapper inventory"` for the source-side inventory check before exercising extraction. It names missing eager runtime imports, forked children named through `resolveRuntimeProcessEntrypointUrl`, and stale deleted paths; existing shell-launched helpers, workers, and data assets remain explicit inventory roots.

Materialized anchors use `openclaw-pr-anchor-v3.<creator-pid>.<suffix>` directories.
The creator owns retirement across its exec chain through the directory identity
held on FD 9; an inherited path or a descendant does not grant deletion authority.
New materializations also inherit FD 7, holding a shared `flock` on a private
lifetime file outside the anchor. Shell children inherit it; the bootstrap Node
preload preserves it through Node and Bun subprocess APIs, which otherwise close
extra descriptors. A nested operation with its own cache namespace or lifetime
retains enclosing leases on additional descriptors, so its children protect both
operations even after both creators exit. This descriptor grants liveness protection, not creator
retirement authority. Python 3's standard-library `fcntl` supplies the kernel lock.
Lifetime registration also covers operations that reuse installed dependencies
without acquiring a cache entry. Creation intent precedes the lifetime file;
the operation registers its shared lock before materializing or dispatching tools.
Interrupted pre-registration intent has no dependency consumers yet: recovery
requires the creator incarnation to be gone, no current filesystem references,
and an exclusive lock if its lifetime file was created.
Collection requires a non-blocking exclusive lock and keeps it through anchor
removal. Killing the creator cannot release a surviving child's shared lock.
Normal completion also leaves retirement to the next invocation, after the
creator's final descriptor closes. A closed output reader still exits 141.
Programs must preserve the lifetime descriptor while using the anchored tools;
the preload refuses a missing or conflicting descriptor instead of launching an
unprotected Node consumer.

Pre-lease anchors use the disposable-scratch policy: the anchor must be older
than 24 hours, its creator incarnation must be gone, and no process may reference
the anchor or its entries through cwd, open descriptors, or mappings. Linux uses
`/proc`; macOS uses `ps` and `lsof`. Failed observation retains the resources.
An unreaped Linux zombie with no surviving threads has already released its
filesystem references; unreadable live processes still prevent collection.
PID reuse is checked against anchor creation time; ambiguous timestamps retain
the anchor. This deliberately accepts an old, dormant legacy child that keeps
only a pathname in memory: scratch older than 24 hours can disappear and must be
reinstalled on miss. This age-based tradeoff never substitutes for a new hold's
flock evidence. Missing or changed new lifetime files retain their holds.
Explicit [release of finished dependency holds](#release-finished-dependency-holds)
remains available and also respects new shared locks.
A retained PR operation lock requires its separate `lock-recover` procedure after
verifying that no child tools remain.

`OPENCLAW_PR_TOOLING_ROOT` selects a full checkout of the same repository for
materialized wrappers' third-party dependencies; otherwise `openclaw.pr.toolingRoot` in the
canonical checkout's Git config applies, then the canonical checkout itself.
The standalone CI watcher and Crabbox entrypoint resolve missing third-party
packages from the same tooling root when their checkout has no `node_modules`,
with the same explicit-root identity checks and exact package versions. They
never link an installation or resolve workspace packages from another checkout.
The line-cap ratchet uses this same no-link, third-party-only admission and runs the package-owned oxlint CLI with the same Node executable.
The wrapper still selects and verifies code against the existing trust anchor.
Installed package versions must exactly match the anchor manifest. On mismatch,
the current wrapper extracts the authenticated anchor commit into a private
staging directory and runs `pnpm install --frozen-lockfile --prefer-offline`, with
normal workspace and lifecycle policy. It verifies the extracted source against
Git before installation, then asks the anchor's own materializer to recheck exact
versions. A successful installation is published atomically under
`~/.cache/openclaw/pr-dependencies/v3/`; concurrent creators keep the first complete
entry and discard their staging copies. This namespace contains `lifetime.sqlite`,
the authoritative owner of installation identities, anchor holds, settlement,
and reuse ordering. Versioned cache and anchor names keep older PID-based
collectors from reclaiming these resources. Legacy cache installations cannot
supply tooling dependencies to the current lifetime owner.

The cache key covers the install inputs, platform, architecture, and Node ABI.
For the audited source-install path, unrelated source revisions reuse the same
installation. `scripts/pr-lib/dependency-inputs.json` records the lifecycle read
set: all package manifests, lockfile, workspace/package-manager configuration,
patches, lifecycle code (including `pnpm:devPreinstall`) and its imports, both
SQL schemas, and the native protocol generator's declared inputs and TypeScript
configuration. Git-hook setup reads the presence of its
directory, not hook contents. Generated outputs start absent in the archive.
The full archive still undergoes the same Git blob, mode, symlink, and inventory
verification before installation; sharing changes only dependency identity.

The audit signature covers executable inputs and dependency/build policy.
Changes to those inputs, a different runtime, a tracked `dist/` tree, or an older
wrapper without an audit retain full-tree keying. This prevents a changed hook
from reading a new source path while reusing an installation based on the old
read set. SQL schemas are executable inputs too: the generator passes them to
SQLite. To renew an audit, trace the root/workspace hooks and allowed dependency
builds, update the read set, then set `auditSha256` to SHA-256 of the selected
`git ls-tree -r -z <revision>` rows (without the final NUL).
The current audit qualifies Darwin arm64 and its recorded Node ABI; other
platforms retain full-tree isolation until their dependency builds are audited.
The current wrapper can prepare dependencies for older retained workflows without
changing their binding or executing newer workflow code in their place.

Each acquisition records an anchor hold in SQLite and marks the installation
unsettled. Additive tables in the same ledger record operation lifetimes and
pending lifetime creation, installation, or eviction transitions; the ledger version is unchanged.
The hold remains committed throughout anchor retirement. After confirmed anchor removal, the owner revalidates ledger,
installation, and hold identities before releasing that anchor's holds in SQLite.
The installation becomes settled only when no holds remain. Failed settlement
retains the recorded holds even if the anchor is already absent.

Each ordinary invocation collects before acquiring dependencies, including when
an installed checkout can supply them. Discovery and explicit recovery commands
retain their independent bootstrap behavior. Collection keeps the four most recently used
settled installations with no holds. Reuse order comes from the ledger's
sequence, not filesystem modification times. Held or unsettled installations
remain protected until their lifetime evidence permits settlement. Collection
retires at most four anchor, stage, or entry directories per invocation; subsequent
invocations drain a larger backlog. This bounds deletion count, not the time to
inspect or remove one directory. It rechecks physical identities and never follows
aliases. The metadata critical section also has an inherited kernel lock, so a
killed owner cannot strand its mutex or abandon a still-running deletion helper.

Stage intent commits before directory creation. Publication keeps that intent
until the installation and hold commit; eviction records detach intent in the
same transaction that removes reuse eligibility. The next collector can finish
either side of an interrupted rename. Existing unregistered hash entries, stages,
and detached entries are disposable orphans: collection requires their newest
recursive mtime to be older than 24 hours and no cwd, descriptor, or mapping
reference. Recent orphans and live pending installations stay intact.

The canonical and explicit tooling roots are never fetched, fast-forwarded, or
reinstalled by this path. Explicit-root identity checks remain unchanged, and
matching installed packages still take the direct path. Keep any externally
managed installation intact until its consumers finish.

## Qualify the workspace before review

Before the first `review-init`, run:

```bash
scripts/pr workspace <PR>
```

This read-only preflight prints JSON with the physical `canonicalRoot`,
`commonGitDir`, and `worktree`, plus the derived `artifactDirectory` and `reviewJson`
paths. It needs no third-party Node dependencies or GitHub authentication,
including when trusted wrapper code must be materialized. It does not call
GitHub, acquire a PR lock, admit a workflow, install
dependencies, create the checkout, or change existing PR state. Normal wrapper
source qualification still applies. The result is a location report, not proof
of sandbox permission or landing readiness.

Confirm that the file tools used to read and edit review artifacts can access
these physical paths. Shell access alone is not sufficient. A linked task
worktree does not move PR artifacts into the task directory: the canonical
repository still owns `.worktrees/pr-<PR>/.local`. `OPENCLAW_PR_TOOLING_ROOT`
changes third-party dependency sourcing only, never this location or the shared
lock, workflow-binding, and merge-outcome owners.

Native PR tooling already supports an operator-provisioned symlink at the
canonical `.worktrees` parent. The preflight resolves that target, and provisioning
uses native Git there while keeping the same canonical repository and state
owners. Reuse this object store instead of cloning for each task. Do not repoint a
shared parent or move existing PR worktrees to solve one task’s access problem;
provisioning that shared layout belongs to its operator, not the caller.

If no existing supported location is accessible, create a separate ordinary
checkout inside the allowed workspace **before starting the PR workflow**, then
repeat this preflight:

```bash
git clone --filter=blob:none --single-branch --branch main \
  https://github.com/openclaw/openclaw.git /allowed/workspace/openclaw
```

Keep full commit history (no `--depth`) and a full working tree (no `--sparse`);
historical blobs can stay omitted. `--single-branch` alone does **not** limit blob
history. This fallback still downloads commits, trees, and checkout blobs; use
the existing base whenever its canonical paths are accessible. `--reference`
rejects shallow donors, and `--dissociate` copies borrowed objects, so neither is
the default replacement for a shared worktree. Never move an active or uncertain
operation to another clone: first reconcile it through the native recovery owner
in the original repository. A new clone has a different lock/outcome namespace.

## Reuse the base and fetch only needed history

Never use `fetch --depth`, `pull --depth`, `--shallow-since`, or
`--shallow-exclude` in a managed base or its linked worktrees: their shallow
boundary is shared. Fetch the required ref without a depth limit. If a managed
base is already shallow, use `openclaw doctor --fix`; keep `blob:none`.

Start in the assigned managed/task worktree. `scripts/pr review-init <PR>`
provisions `.worktrees/pr-<PR>` through the worktree owner; it shares the canonical
object store. Do not manually create that PR directory or clone into scratch to
obtain main. For ordinary task isolation outside the managed lifecycle, native
`git -C <base> worktree add -b <task-branch> <allowed-task-path> <start-commit>`
also shares objects. A linked worktree still requires access to its canonical
Git directory and does not fix an inaccessible `scripts/pr workspace` result.

Never clone the base's local path for landing or recovery: Git's default local
clone hardlinks its packs, so a forgotten clone pins packs retired by base
maintenance. Do not copy or relink packs into existing task scratch. Use the
shared worktree owner above; its cleanup owns the checkout when the task ends.
Disposable legacy clones under `.openclaw/tmp/` expire through scratch maintenance,
including their dependency symlinks and hardlinked objects. Keep unfinished
durable work outside scratch.

Start native operations with the current trusted `scripts/pr`, which selects
canonical-main code, rather than invoking a historical PR branch's `pr-lib`
helpers directly. Retained workflows keep their pinned code and outcome namespace;
use `prepare-workflow-successor` below when they need newer tooling, after
reconciling any pending operation. Repeatedly fetching main from an old clone
does not upgrade its running wrapper.

PR review and landing need commits and trees for merge-base, ancestry checks,
and log ranges, plus blobs for the checked-out files, diffs, and merges. They do
not need every historical blob. The source-acquisition owner retains the base's
promisor filter; missing checkout/diff blobs are fetched on demand. Do not clear
promisor settings, fetch with `--no-filter`, or repack just to review a PR.

If ancestry fails, first distinguish a shallow boundary from an unavailable
commit or genuinely unrelated histories:

```bash
git rev-parse --is-shallow-repository
git --no-lazy-fetch merge-base --all "$main_sha" "$head_sha"
```

Use the exact main and PR head SHAs from the current PR observation. For a
registry-owned managed base, the existing migration is `openclaw doctor --fix`:
it fetches full commit history with `blob:none` under the project checkout
lifecycle lease, skipping busy clones. The operator must own that repair; do not
manually deepen a live managed base or run a broad Doctor repair outside task
authority. See [project clone repair](/gateway/doctor/gateway-and-services#11e-project-clone-shape).

For a task-owned ordinary shallow clone, acquire only the required range before
workflow admission (or after the failed command has exited and its native lock
is settled):

```bash
git fetch --deepen=256 --filter=blob:none --no-tags --no-auto-maintenance \
  --no-write-fetch-head --refmap= origin "$main_sha" "$head_sha"
git --no-lazy-fetch merge-base --all "$main_sha" "$head_sha"
```

This preserves shared refs and `FETCH_HEAD`; it extends the shared shallow
boundary, so coordinate with other users of that object store. Stop once the
needed merge-base is available. If 256 commits are insufficient, use one larger
batch (`--deepen=1024`) and check again. A release-wide history audit or an older
PR may need complete commit history: use `--unshallow` in place of `--deepen`
while retaining the other flags, then rerun the failed history operation.
Full commit history and full blob history are different requirements.

A failed fetch, a still-shallow origin, or a missing local-only snapshot parent
is not repaired by repeatedly cloning GitHub. Preserve the checkout and native
workflow evidence; report the failing command and missing object/ref, restore
origin access or recover the parent from its original repository, and retry
through the same owner. An available merge-base proves that range, not arbitrary
older ancestry; qualify any older refs required by release or recovery separately.

## Keep the admitted workflow across commands

The first locked operation for a PR retains its authenticated workflow source in
`refs/openclaw/pr-workflow-bindings/<pr>`. Later operations use that source and
its dependency manifest, even when main advances. The binding belongs to the
canonical repository and PR; a caller cannot select an arbitrary revision or
replace it with an environment variable. Malformed, foreign, or changed bindings
fail closed. Developer-wrapper opt-in does not change landing authority.

Security Review publisher sources have a separate owner: the protected-main tip
captured by merge admission. For inherited-failure admin admission, the publisher
must be a successful Security Review run on that main history, and its workflow
and every declared checkout source must match that tip's Git blobs. The verified
workflow supplies the checkout inventory; the bound wrapper's older files do not.
Initial admission reads those owner blobs from GitHub at the captured main SHA,
so it does not require a newly observed main to be materialized locally yet. The
final local-only source check still follows main materialization.
An older run remains eligible only while all publisher sources still match main.
Foreign, malformed, or outdated sources refuse admission. This does not refresh
or replace the retained workflow binding, select caller-provided source code, or
waive exact-head security enforcement and current review authority.

Workflow selection crosses supervision through a private held descriptor. This
is separate from the descriptor that owns temporary wrapper cleanup. Reentry
must verify the complete source inventory and manifest against the selected
commit before using it. Keep the retained installation available until the PR
operation completes; a workflow binding does not freeze installed package bytes.

When `refs/remotes/origin/main` is absent, only the clean, HEAD-verified canonical
wrapper can bootstrap. After acquiring the PR operation lock and checking
temporary storage and GitHub authentication, it fetches canonical main into an
operation-owned qualification ref. This extra acquisition does not update the
shared tracking ref or `FETCH_HEAD`. A retained binding must belong to that main
history, and the running wrapper must match the selected source exactly. A
symbolic or unreadable tracking ref is not a cold-start fallback.

Successful qualification removes only its captured ref value. Failed or
interrupted qualification can retain its ref and operation lock; preserve the
reported evidence and use native exact-owner recovery after all children join.
If source comparison fails, use a qualified checkout of the reported source;
do not erase the binding or substitute newer workflow code. Existing-worktree
and completion-only commands do not provision a worktree for this acquisition.
`prepare-push --resume-crabbox-run` requires the existing authenticated tracking
anchor and refuses cold acquisition before any fetch.

Confirmed prior-CI admin first admission may explicitly select current official
main with `merge-run --current-workflow --admin-evidence <file>
--confirmed-operator-admin` when no outcome or unresolved capture exists.
The native selection descriptor and locked source verification preserve the exact
original binding. Additive `workflowAdmission` provenance retains both sources
through outcome ancestry, including successors written by older bound tooling.
This is per-invocation selection, not a permanent rebind; see
[artifact-build admission](/reference/scripts/prior-ci#artifact-build-failure-with-successful-primary-ci).

Only verified native merge completion retires the exact workflow binding.
Failures and pending completion preserve it. Repeating completion reconciles
the merge outcome without repeating publication, comments, or cleanup.

### Salvage an unknown file in an interrupted review checkout

Automatic replay refuses working files that match neither journal endpoint,
including empty files. Do not infer that an empty file belongs to a failed
restore. After explicitly selecting and preserving its unknown bytes, an operator
can repair one regular file through the existing checkout owner:

```bash
scripts/pr review-transition-recover <PR> <plan.json> \
  --plan-sha256 <SHA256> --confirmed-operator-recovery
```

The sealed version-1 plan contains numeric `pr`, the original `binding` OID,
`head` commit, `headRef` (empty for detached HEAD), `journalSha256`, raw
`indexSha256`, a repository-relative `path`, its current `workingEntry`
(Git mode, one space, and the unfiltered blob OID), and a nonempty `reason`.
Inspect these values from the retained checkout; the hash binds exact plan bytes.
The path must be a regular file in both endpoints of a detached review journal.
Preparation/correction journals, symlinks, directories, and arbitrary replacement
content are not supported. Quiesce other writers to this checkout before repair;
the PR mutex excludes other native operations, not manual editor writes.

This landing-class command qualifies current official-main wrapper code under the
original PR lock, without replacing the retained workflow binding. Land and
independently review any required tooling change before using it. Developer
wrapper opt-in and an unlanded implementation cannot authorize recovery.

Before replacement, the owner preserves the exact plan, unknown file bytes,
journal/index preimages, and tooling provenance in the private named backup
`.local/review-transition-recovery.<plan-SHA256>/`. It atomically restores only
the selected working file to its journaled source blob. HEAD, the index, journal,
workflow binding, and all other paths stay unchanged. The result says the file is
repaired and the transition remains pending; use ordinary bound
`review-checkout-pr` afterward. Other unknown state still refuses normal replay.

After an interrupted or lost response, inspect the selected path and backup.
Repeating the exact sealed operation verifies that backup before recognizing an
already repaired source entry; it never blindly overwrites a newer edit or
removes the backup. Keep it until the original PR operation completes.

### Continue a correction with repaired workflow code

An unfinished correction can need a landed tooling repair before its retained
workflow can finish preparation. Use the explicit successor command from the
current qualified canonical wrapper:

```bash
scripts/pr prepare-workflow-successor <PR> \
  --expected-binding <binding-OID> --from-workflow <old-SHA> --to-workflow <current-main-SHA> \
  --expected-head <local-head> --expected-tree <tree-OID> \
  --expected-review <correction-review-blob-OID> --expected-hosted-head <hosted-head>
```

First establish that every tool from an interrupted operation has finished and
use its reported exact-OID `lock-recover` command. Succession does not recover
locks or infer quiescence. It requires the existing registered correction
checkout, unchanged clean source, approved correction review, exact hosted
publication authority, and no merge outcome, unresolved capture, or pending
dispatch. The destination must be the authenticated current official main;
unlanded code, arbitrary revisions, and admin admission flags are not accepted.

The normal supervisor and PR operation lock protect this transition. It retains
and verifies preparation evidence, preserves `prep.env` and all review/source
facts, then removes only `gates.env`. A single Git transaction verifies the
operation owner and advances the exact predecessor binding. The new binding
retains the old binding, both source identities, local/hosted commits, and the
review snapshot. Existing version-1 bindings remain valid historical authority.

An interruption before the binding transaction preserves the old binding; one
after it can leave the new binding even without a successful return. Inspect
the exact retained binding and evidence before continuing; do not blindly repeat
the transition or restore an archived gate stamp. Both states require fresh
ordinary `prepare-gates` before qualified correction publication or merge.
For an explicitly authorized pending-proof correction, `--for-proof` instead
validates the typed [proof-publication review](/reference/scripts/pr-preparation#publish-a-candidate-for-required-proof).
It admits only exact-commit proof publication while NEEDS WORK and unresolved
findings continue to block ordinary qualification and merge. This command
does not change the candidate, publish it, waive CI/security/review requirements,
or authorize a merge.

## Reconcile a completed CI review

If native landing rejects an older Security Review publisher because its sources
no longer match protected main, a human with repository `maintain` or `admin`
access can post a new PR comment containing only:

```text
/refresh-security-review <full-current-head-sha>
```

Use the full 40-character lowercase commit SHA. The command rechecks the comment
author's current repository role and selects only that open, non-draft PR while
its head still matches. Edited or deleted refresh comments do not trigger a
refresh. The new `issue_comment` review uses protected-main publisher sources and
the existing head-only review job, including for older native workflow bindings.
It reevaluates current CI and security requirements; it does not rerun CI, approve
changes, alter a workflow binding, or waive a failed check. Keep refresh and
approval commands in separate comments; a mixed comment grants no approval.

If CI completed but its combined `openclaw/ci-gate` commit status remains pending,
maintainers can replay Security Review for that exact CI run:

```bash
gh workflow run security-review.yml --ref main -f completed_ci_run_id=<run-id>
```

The replay validates the completed run's repository and workflow, then selects
only current PRs whose head, source repository, and branch still match. It runs
the ordinary security review and CI checks; it does not rerun CI or waive a gate.
The dispatch must use the default branch. A stale run cannot approve a newer PR head.
Native prior-CI admission accepts the replay only when its successful security
enforcement names the selected PR head, CI run, and attempt. Protected publisher
source and current review authority checks still apply.

Completion reviews retain the observed run ID and attempt. Missing or older
observations retry within the existing recovery budget; exhaustion fails the
scheduled pass so its scan window remains eligible. A newer active run or attempt
keeps the status pending until that run completes.

## Recover dependency-cache device identities

The lifetime ledger binds the cache, database, and installations to their device
numbers, inodes, owners, and modes. A device-number change can make ordinary
commands refuse the ledger. Matching inodes or a recent reboot do not prove that
the same volume remains mounted. Ordinary commands never repair this mismatch.

After independently inspecting the complete cache and accepting its current
identity, an operator can adopt only its device numbers:

```bash
scripts/pr dependency-cache-recover <plan.json> \
  --plan-sha256 <SHA256> --confirmed-operator-recovery
```

This shared-cache operation uses the existing metadata mutex, not a PR lock or
workflow binding. It requires the official OpenClaw origin and authenticates the
complete official-main wrapper before opening the ledger, using only Git and
Node built-ins for authentication. The metadata lock uses Python's standard
library. Origin admission runs before wrapper substitution or bootstrap.
Review and land tooling repairs before use. Developer-wrapper opt-in and unlanded
code do not authorize recovery. The command does not install packages or select
another dependency donor.

When source selection materializes a temporary wrapper, recovery retains that
directory and prints its path on both success and failure. Ordinary anchor
retirement opens the ledger and could roll back an unresolved SQLite journal.
Recovery therefore performs no exit-time cache cleanup or hold settlement.

The SHA-256 seals exact UTF-8 JSON bytes. The version-1 plan contains:

- `version: 1`, the physical `cache` path returned by `dependencyCacheRoot()`, and
  a nonempty `reason` recording the operator's identity decision.
- `before`: complete `owner`, `installations`, and `holds` row arrays. Include
  every column and preserve SQLite value types. Sort owner rows by `id`,
  installations by `key`, and holds by `entry_key`, `anchor_path`, `anchor_dev`,
  then `anchor_ino`. When any additive lifetime table has rows, also include all
  three arrays: `pending_lifetimes`, `operation_lifetimes`, and
  `dependency_transitions`. Sort lifetimes by `anchor_path`, `anchor_dev`, then
  `anchor_ino`, and transitions by `path`.
- `physical`: `cache` and `database` identities, plus an `installations` array
  ordered by key. Each installation has `key` and its physical identity.
  Identities contain decimal strings for `dev`, `ino`, `uid`, and `mode` from
  `lstat`. The database is the existing `lifetime.sqlite` file.
- With additive rows, `physical.resources` seals their anchor and lease paths,
  plus both names of each pending filesystem transition outside registered
  installations. Each element is `{ path, identity }`, sorted by path using
  `localeCompare`; `identity` is the same four-field record, or `null` for an
  absent resource. Plans for old ledgers or empty additive tables omit these
  extra arrays and resources.

Preserve the sealed plan until reconciliation finishes. Exclude manual ledger
writers and cache-directory replacement throughout inspection and recovery; the
metadata mutex serializes native owners only. The cache must contain exactly the
ledger, registered installations, and sealed lifetime/transition resources, with
no unresolved journal or unknown entries. Recorded cache, database, and installation device numbers must identify
one old device, and their current identities must identify one new device. Inodes,
owners, modes, schema, and integrity must match.

The owner compares the complete logical preimage inside one synchronous SQLite
write transaction. It updates only `owner.cache_dev`, `owner.db_dev`, and each
registered `installations.dev`, plus device cells in lifetime, transition, and
hold rows whose present resource identities prove the same device change.
Absent resources retain their recorded identities. It preserves all holds,
and preserves sequence, settlement, reuse order, and installed contents. Recovery
grants no collection, anchor retirement, or hold-release authority.

Success prints `recovered` with the plan seal and installation count. After an
interruption or lost response, repeat only the same sealed plan: the exact
postimage returns `already-recovered` without changing rows. Any third state
refuses and requires fresh inspection. A failure is not proof that no commit
occurred. After verified recovery, use the original command's ordinary admission;
its existing source, dependency, and workflow requirements still apply.

## Release finished dependency holds

A creator that exits before retiring its anchor can leave dependency holds behind.
After reviewing the consumers and recovery obligations, an operator can release
those holds with a sealed plan:

```bash
scripts/pr dependency-hold-release --dry-run [--anchor <path>]... > plan.json
scripts/pr dependency-hold-release plan.json --plan-sha256 <SHA256> --confirmed-no-running-tools
```

The dry run writes only the plan JSON to stdout and a human review, summary, seal,
and release command to stderr. It changes no ledger rows or anchors. Repeatable
`--anchor` arguments select exact paths; an unknown path refuses. With no holds,
the report is an empty plan. Blocked anchors remain in the report, and a completed
dry run exits successfully even when none can release.

The same official-main authentication as `dependency-cache-recover` applies before
ledger access. Developer-wrapper opt-in cannot admit unlanded release code. This
command uses Node built-ins, `ps`, and `lsof`, takes the shared metadata mutex only
for ledger work, and never installs or materializes dependencies.

The operator must attest that no detached PR tools still consume these resources,
that retained PR operation locks have already been resolved through `lock-recover`,
and that no retained `tooling-recover` obligation remains. Evidence alone grants
no release authority. Preserve this exclusion until the outcome is reconciled.

The dry run scans processes once; release rescans immediately before each anchor.
Scans run outside the metadata mutex, which other wrappers wait on for at most one
second. Each checks creator PIDs, process groups, command lines, and open files.
A live same-user creator or process in its group blocks release;
PID reuse by the same user intentionally delays it, while a foreign-user PID is
recorded separately. Any process referencing an anchor basename or one of its
entry keys blocks release, including every other anchor holding that entry.
The command and its ancestors are excluded only from command-line matching,
never open-file matching. A changed anchor identity or a missing or changed entry
also blocks release. Scan errors, empty output, and unavailable tools stop the
command; outcomes already printed stand. Missing anchors can release; their
disappearance alone is never authority. A hold taken by a live wrapper during a
batch is safe by accounting: its anchor is not in the sealed plan, and its row
keeps the entry unsettled.

The version-1 plan records the physical `cache` path, releasable `anchors`, and
`blocked` anchors with their blockers. Every anchor has its path and decimal
`dev`, `ino`, `uid`, and `mode` identities, plus `holds` with each 64-hex entry key
and its identities. Evidence records anchor presence, birthtime when present,
creator PID and state, and process references with PID, source, target, and a
bounded command line. Birthtime is informational. The SHA-256 seals the exact
stdout bytes; release validates the plan and gathers evidence again.

Release acts only on `anchors`. Under the metadata mutex, the owner requires the
exact reviewed holds and installation identities. It then retires a present
anchor outside the mutex before releasing holds in a revalidated SQLite
transaction, in the creator's original order. An absent anchor skips removal.
An entry settles only when its last hold releases; co-held entries remain
unsettled. Each planned anchor prints a JSON outcome: `released` with `settled`
and `retained` entry keys, `already-released`, `blocked` with blockers, or `refused`
with a reason. Failures do not stop other anchors; exit 0 requires every planned
anchor to finish released or already released.

Keep the plan and seal. Rerunning the same sealed plan after interruption or a
lost reply is safe; `already-released` is expected and never removes a replacement
path. The next materialization's existing collector handles eligible eviction
and deletes evicted entries synchronously. After a large release, the next
materializing wrapper run pays for those deletions before it continues.
This command deletes no cache entry. Never edit `lifetime.sqlite` or delete cache
entries by hand.

## Recover a retained dependency projection

When a retained anchor's pinned package directory disappears, changing
`OPENCLAW_PR_TOOLING_ROOT` alone does not replace that pin. The current trusted
wrapper can recover the complete projection without changing frozen wrapper code:

```bash
scripts/pr tooling-recover <PR> <plan.json> --plan-sha256 <sha256> --confirmed-quiescent
```

This Linux operation requires a healthy current wrapper installation. It acquires
the ordinary supervised PR operation lock before reading the recovery plan. The
target is a different retained anchor, never the executing wrapper. Developer
wrapper opt-in cannot admit it. It neither installs packages nor refreshes a donor.

Before dispatch, the native owner must exclude every consumer of the target
anchor and donor installation, and qualify directory `RENAME_EXCHANGE` on the
target device with GNU `mv --exchange --no-copy -T`. Hold that exclusion through
outcome reconciliation. `--confirmed-quiescent` records this operator obligation;
a plan file is not custody authority. The PR mutex alone does not exclude another
consumer's dependency reads. The original creator PID/FD cleanup contract remains
unchanged; recovery does not acquire deletion authority for the anchor.

The SHA-256 binds exact UTF-8 JSON plan bytes. Version 1 contains:

- `version: 1`, numeric `pr`, and the full frozen Git commit `revision`.
- `runtime: { node, platform, arch }`, matching the qualified execution runtime.
- `anchor: { path, identity, parentIdentity, projection }`.
- `donor: { path, identity, parentIdentity, modulesSha256, installLockSha256, packages }`.

An identity records decimal strings for `dev`, `ino`, `uid`, `gid`, and `mode`
from `lstat`. `projection` maps relative names, including `""` for its root, to
these identities; package symlinks also record their exact `target` string.
Only physical scope directories and selective package symlinks are eligible.
Package contents, workspace aliases, and unexpected entries refuse recovery.
`packages` maps every package selected by the frozen materializer to its qualified
physical donor path. The metadata hashes bind `node_modules/.modules.yaml` and
`node_modules/.pnpm/lock.yaml` respectively.

Qualify the donor as a clean, full checkout of the same repository at the frozen
revision, with its own physical pnpm installation. Use its pinned package manager
and frozen lockfile. Before sealing the plan, verify install completion, required
peers, and native/loader imports for the matching runtime; metadata hashes alone
do not establish those facts. Preserve the install through every remaining anchor consumer.
Recovery verifies the checkout, runtime, install metadata, package versions, and
the selected packages' transitive pnpm link closure. It verifies the complete
frozen wrapper inventory against Git before executing the target materializer.

The frozen helper builds an empty sibling projection under the same anchor,
therefore reading the original manifests. Older parents' incomplete selective
sets can be completed. The owner validates the complete replacement and original
preimage, then issues one atomic directory exchange. It reads back **both** inode
identities, independently of the command's exit code. The original projection
remains at the sibling path; frozen source, package contents, donor aliases, and
unrelated anchor entries remain unchanged.

Retain the command's JSON-line stdout in the existing operation evidence. It names
the sibling and original identities before exchange, then reports `exchanged`,
`unchanged`, or `unknown`. Only `complete`, after full projection readback and the
unchanged frozen validator, permits the native owner to continue normal admission.
Any failure or lost response requires identity reconciliation before resume.
Never retry an uncertain exchange, swap back, or delete either path based on exit
status alone. Reusing a successfully exchanged plan refuses its stale preimage.
The command never removes a projection; the native owner releases retained paths
only after their consumers and recovery obligations finish.

Provisioning failures print a redacted error graph to stderr. Preserve that output:
the wrapper does not create a failure receipt. Lease heartbeat responsiveness
errors include the verification, renewal, or acknowledgement phase, the failure
trigger, request counters, elapsed time, and remaining response, operation, and
lease budgets. These are observations taken before failure changes heartbeat
status (`0` starting, `1` ready, `2` closed, `3` lost). An odd renewal-progress
counter means renewal occupied the worker; a completed-request counter can explain
why a negative response budget alone did not fail earlier. Neither extends the
lease or operation budget. The diagnostics do not change timeout or recovery
behavior, and a successful retry does not establish the cause of an earlier failure.

If a settled PR template clone loses its Git registration during provisioning,
the clone owner removes the directory it created and keeps the caller's seed
branch for retry. Older abandoned clones can be inspected with
`scripts/pr gc --pr <number> --dry-run` and removed with `scripts/pr gc --pr <number>`,
including while the PR is open. This recovery requires no PR registration, no
`.local` artifacts, and an intact backlink to a registered template under the
same repository's `.worktrees/.templates`. It checks process working directories
and checks the clone against the PR's retained `temp/pr-<number>` seed using a
temporary index, so later template refreshes cannot make a clean clone appear
edited. Modified, untracked, and ignored files are preserved before revalidating
the clone for removal. A missing seed, missing template metadata, and other
ambiguous directories remain preserved; recovery never deletes their seed branches.

## Captured baseline evidence hashes

Baseline evidence hashes and reconstructed blobs pass the already-captured bytes
to the selected Git executable through a complete, private temporary file. The
writer closes before a fresh read-only descriptor is opened at offset zero; on
the supported POSIX host the pathname and directory are removed before Git starts.
Reconstructed blobs still use Git's `-w` object write; signatures, authority checks,
and operation supervision are unchanged.

Temporary storage must accommodate the largest individual captured file. Ordinary
write, spawn, and Git failures fail closed and clean up owned resources. Unlinking
is not secure erasure, and abrupt termination before unlink can retain a private
snapshot under `TMPDIR`; no automatic sweep of another operation's files occurs.

## Rerun failed CI tests

`pnpm test:ci-failed <pr-number|run-id|run-or-pr-url>` reads failed CI jobs using
the authenticated `gh` CLI and prints focused local proof. `--repo` defaults to
`openclaw/openclaw`. A PR target selects the latest completed or in-progress
`ci.yml` run for its current head SHA; a run target selects that exact run.

The command fetches each failed or timed-out job's log once, with at most four
requests in flight, processes failed jobs concurrently, and skips CI control jobs.
When logs are unavailable or yield no test selections, it recovers reported
failures from check-run annotations. Annotation-only discovery is labeled as
potentially incomplete because Vitest does not annotate every failure. UI shard
paths are resolved relative to `ui/`; annotation titles identify the test entry
point even when the error points into a helper. It shows each job's
pre-existing/new/unknown class and the deduplicated Vitest files and test names.
New and unknown failures appear first; pre-existing failures appear separately
and are excluded from the rerun command unless `--include-pre-existing` is set.
Classification uses the same owner as the PR failure table.

The command prints one `pnpm test <file…>` selection. When there is one file with
at most three safely quoted test names, it adds a test-name filter; otherwise it
reruns the whole selected files. Displayed test-name filters use single quotes
with embedded apostrophes escaped for safe copying into zsh or bash; execution
arguments remain unquoted. Non-Vitest failures show their failed step names and
“no Vitest rerun; read log” with the job log URL. `--run` executes the selected
test command with the local runner's default worker behavior. `--json` emits
`{ run, failures: [{ job, class, files: [{ file, tests }], failedSteps, url, reason }], command }`.

`--run` sets `OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE=1` so ordinary test failures do not hide later selected files; use the same opt-in with manual `pnpm test` commands, while infrastructure failures still stop scheduling.

After PR CI fails, run `pnpm test:ci-failed <pr>`, fix new failures and investigate
unknown ones, then run `pnpm test:ci-failed <pr> --run` until those pass locally
and push once. PR CI supplies broad proof for the repaired head. Never run the
full local suite or use `gh run rerun` to chase green. Pre-existing failures
follow the
[failure-table landing rule](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-pr-maintainer/references/landing.md#red-main-and-inherited-failures);
the table supplies evidence, not an automatic gate waiver.
