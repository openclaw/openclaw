---
summary: "Canonical wrapper trust, process locks, and materialized dependencies for scripts/pr"
read_when:
  - Changing PR wrapper supervision, locks, dependency materialization, or tooling-root selection
title: "PR wrapper tooling"
---

# PR wrapper tooling

- Supervised PR operations disable automatic Git maintenance through inherited process configuration, preserving repository settings. Explicit maintenance must still join before completion. PR source fetches also disable automatic maintenance: fetching one PR does not authorize repository-wide pruning of unrelated worktree metadata.

- `scripts/pr` serializes review, prepare, and merge operations per PR across linked worktrees; `scripts/pr gc` skips active or indeterminate locks. Its subcommand classification table is the canonical wrapper trust boundary: a mismatched local wrapper may run only a classified `advisory` subcommand with `--dev-wrapper` or `OPENCLAW_PR_DEV_WRAPPER=1`; classified `landing` subcommands always require canonical/origin-main wrapper code. A worktree whose wrapper differs from origin/main (stale base or wrapper-editing branch) loudly substitutes the canonical checkout's wrapper when that checkout is clean and byte-identical to fetched `refs/remotes/origin/main`; it refuses only when no anchor-matching wrapper is available. A successful command return is the trusted synchronous-completion contract: every PR-state-mutating child must be joined before returning, and such work must never daemonize or explicitly escape both the operation group and lock-notification FD. Release on clean exit requires the leader's completion marker; an escaped descendant that merely holds the notify pipe then produces a loud warned release instead of retention (#124583). A failed command auto-releases while its explicit pre-side-effect validation marker remains active, or after side effects when it exits on its own (status 1-127, no signal) and the full drain observes its group dead and every notification-pipe holder gone; that leaves only the fd-closing escapee residual a clean exit already accepts. Interruptions, lingering group work, a still-open pipe, and controller loss stay locked because detached children cannot be disproved. After verifying no child tools remain, use the reported exact-OID `scripts/pr lock-recover` command. Never bypass or delete these refs manually.
- Materialized wrappers pin selective third-party dependencies to their installed real package directories before handoff, not mutable top-level `node_modules` aliases. The anchored `pr-lib/materialize-dependencies.mjs` owns that set; the child completes it on handoff too, because an older parent may pin fewer packages. Reentry preserves already pinned installations. For anchors predating that helper, the parent performs the same setup against the extracted manifest; pre-#149585 anchors without a manifest retain their original four tooling dependencies. Missing package directories or versions that differ from the anchored package manifest fail before lock acquisition; restore frozen dependencies in a clean trusted-main checkout and retry. Do not link the whole workspace dependency tree or install into the canonical checkout during materialization; only the explicitly selected separate tooling root below may refresh. Keep the resolved package installation intact until the supervised command finishes; pinning paths does not copy or freeze package contents. `test/scripts/eager-import-closure.test.ts` checks archived eager imports against copied sources and pinned package exports; keep `pr-lib/wrapper-components.txt` current when that source closure changes. Run `pnpm test test/scripts/eager-import-closure.test.ts -t "PR wrapper inventory"` for the source-side inventory check before exercising extraction. It names missing eager runtime imports and stale deleted paths; existing shell-launched helpers, workers, and data assets remain explicit inventory roots.

Materialized anchors use `openclaw-pr-anchor.<creator-pid>.<suffix>` directories.
The creator owns retirement across its exec chain, including success, failure,
signals, and failed execs; a supervised operation retains its anchor only while
its process group or notification pipe has not drained. Every supervisor startup
also sweeps at most four owned, mode-0700 anchor directories whose modification
and change times are both older than 24 hours, excluding its own anchor and any
recorded live creator PID. Legacy names without a PID qualify by age alone. A dead
creator is the sweep's only evidence that an operation ended: descendants still
running 24 hours after a crashed or undrained supervisor can lose their anchor,
while that operation's retained PR lock still requires `lock-recover`.

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
an explicitly selected, separate, clean `main` checkout is fetched, fast-forwarded,
and installed with `pnpm install --frozen-lockfile` once before rechecking. Fetch and
fast-forward output streams to stderr, without a diffstat, instead of being captured,
so a root thousands of commits behind refreshes regardless of output size. A stale
dirty or non-main root cannot refresh; sparse and unrelated roots are always
refused. The canonical checkout is never refreshed. Keep the selected installation
intact until the command finishes. This setting applies at both dependency
materialization handoffs; in-place wrappers keep their checkout's dependency
context, and wrapper selection stays unchanged.

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

Only verified native merge completion retires the exact workflow binding.
Failures and pending completion preserve it. Repeating completion reconciles
the merge outcome without repeating publication, comments, or cleanup.

## Reconcile a completed CI review

If CI completed but its combined `openclaw/ci-gate` commit status remains pending,
maintainers can replay Security Review for that exact CI run:

```bash
gh workflow run security-review.yml --ref main -f completed_ci_run_id=<run-id>
```

The replay validates the completed run's repository and workflow, then selects
only current PRs whose head, source repository, and branch still match. It runs
the ordinary security review and CI checks; it does not rerun CI or waive a gate.
The dispatch must use the default branch. A stale run cannot approve a newer PR head.

Completion reviews retain the observed run ID and attempt. Missing or older
observations retry within the existing recovery budget; exhaustion fails the
scheduled pass so its scan window remains eligible. A newer active run or attempt
keeps the status pending until that run completes.

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

Read-only baseline evidence hashes pass the already-captured bytes to the selected
Git executable through a complete, private temporary file. The writer closes before
a fresh read-only descriptor is opened at offset zero; on the supported POSIX
host the pathname and directory are removed before Git starts. Write hashes,
signatures, authority checks, and operation supervision are unchanged.

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
It shows each job's pre-existing/new/unknown class and the deduplicated Vitest
files and test names.
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
