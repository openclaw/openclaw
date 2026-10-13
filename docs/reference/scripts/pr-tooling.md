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

`OPENCLAW_PR_TOOLING_ROOT` selects a full checkout of the same repository for
materialized wrappers' third-party dependencies; otherwise `openclaw.pr.toolingRoot` in the
canonical checkout's Git config applies, then the canonical checkout itself.
The standalone CI watcher and Crabbox entrypoint resolve missing third-party
packages from the same tooling root when their checkout has no `node_modules`,
with the same explicit-root identity checks and exact package versions. They
never link an installation or resolve workspace packages from another checkout.
The wrapper still selects and verifies code against the existing trust anchor.
Installed package versions must exactly match the anchor manifest. On mismatch,
an explicitly selected, separate, clean `main` checkout is fetched, fast-forwarded,
and installed with `pnpm install --frozen-lockfile` once before rechecking. A stale
dirty or non-main root cannot refresh; sparse and unrelated roots are always
refused. The canonical checkout is never refreshed. Keep the selected installation
intact until the command finishes. This setting applies at both dependency
materialization handoffs; in-place wrappers keep their checkout's dependency
context, and wrapper selection stays unchanged.

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
