---
summary: "Canonical wrapper trust, process locks, and materialized dependencies for scripts/pr"
read_when:
  - Changing PR wrapper supervision, locks, dependency materialization, or tooling-root selection
title: "PR wrapper tooling"
---

# PR wrapper tooling

- Supervised PR operations disable automatic Git maintenance through inherited process configuration, preserving repository settings. Explicit maintenance must still join before completion. PR source fetches also disable automatic maintenance: fetching one PR does not authorize repository-wide pruning of unrelated worktree metadata.

- `scripts/pr` serializes review, prepare, and merge operations per PR across linked worktrees; `scripts/pr gc` skips active or indeterminate locks. Its subcommand classification table is the canonical wrapper trust boundary: a mismatched local wrapper may run only a classified `advisory` subcommand with `--dev-wrapper` or `OPENCLAW_PR_DEV_WRAPPER=1`; classified `landing` subcommands always require canonical/origin-main wrapper code. A worktree whose wrapper differs from origin/main (stale base or wrapper-editing branch) loudly substitutes the canonical checkout's wrapper when that checkout is clean and byte-identical to fetched `refs/remotes/origin/main`; it refuses only when no anchor-matching wrapper is available. A successful command return is the trusted synchronous-completion contract: every PR-state-mutating child must be joined before returning, and such work must never daemonize or explicitly escape both the operation group and lock-notification FD. Release on clean exit requires the leader's completion marker; an escaped descendant that merely holds the notify pipe then produces a loud warned release instead of retention (#124583), while all failure shapes still retain. A failed command auto-releases only while its explicit pre-side-effect validation marker remains active; failures after mutation/tool launch, interruptions, and controller loss stay locked because detached children cannot be disproved. After verifying no child tools remain, use the reported exact-OID `scripts/pr lock-recover` command. Never bypass or delete these refs manually.
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
