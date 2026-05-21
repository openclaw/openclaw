---
summary: "Patch channel for collaborators who run their own OpenClaw and want the fork runtime fixes, the agent-harness tool seam for Kynver tools, and operator harness visibility"
read_when:
  - You already run OpenClaw and want the fork patch set
  - You need install, update, or rollback for the patch channel
  - You need to keep stock openclaw update from clobbering the fork
title: "Kynver patch channel"
sidebarTitle: "Kynver Patch Channel"
---

This page is for technical collaborators and dogfood users who already run their
own OpenClaw and want one place to patch it with the fork runtime fixes, the
agent-harness tool seam for building Kynver first-class tools, and the operator
harness visibility that makes long-running coding work manageable.

It is a curated patch line you build and run yourself on top of stock OpenClaw.
It does not replace stock OpenClaw and it is not a hosted service. This page
covers what the patch does and how to install, operate, and roll it back. It
deliberately does not document harness orchestration internals.

## Who this is for

- You already operate an OpenClaw gateway and are comfortable with a source
  checkout, `pnpm`, and a service manager.
- You want the fork runtime fixes plus the agent-harness tool seam for Kynver
  tools in one place instead of cherry-picking patches.
- You run long coding sessions and need operator visibility into what each
  worker is doing.

If you only want stock OpenClaw, use the normal [install](/install) and
[updating](/install/updating) flows instead. This patch channel adds operating
burden in exchange for the fork patch set.

## Where the patch lives

The patch line is published on the fork remote:

```
https://github.com/Totalsolutionsync/openclaw
```

There are currently two relevant lines, and they are not yet unified. Always
pin to a specific commit, never to a moving branch.

- **Dogfood line.** Branch `agent/phase05b-safe-prep`, current tip commit
  `d71d84f`. This carries the reproducible build, deploy, and rollback pipeline,
  the worker-completion wake, the public agent-harness tool seam, and a set of
  forward-ported runtime fixes. This is the line this page documents.
- **Runtime line.** Branch `agent/lane-pump-and-stall-recovery`, commit
  `9d2731780`. This is where the lane pump and stall recovery work lives. It is
  the source of the local release id `fork-9d273178-...` and is **not** merged
  into the dogfood line yet.

A release id like `fork-9d273178-...` names the commit it was built from. If you
are running that release you are on the runtime line (`9d2731780`), not the
dogfood line (`d71d84f`). Confirm which line you are on before reporting a fix as
present or missing:

```bash
git -C <checkout> rev-parse HEAD
git -C <checkout> log --oneline -1
```

## What runtime fixes are included

Verified on the dogfood line (`agent/phase05b-safe-prep` at `d71d84f`), phrased
from an operator point of view:

- **Reproducible deploys with one-command rollback.** Every deploy is one whole
  consistent build, activated by an atomic symlink swap, and rollback is the same
  swap in reverse. A half-applied or mixed-commit build is refused before it goes
  live. See [Deploy pipeline](/reference/deploy-pipeline).
- **Telegram runtime resilience.** Spool timeout recovery, preserved reply
  context, topic and queue handling, and native progress drafts so long turns do
  not spam the transcript or strand a reply.
- **Auth resilience.** Legacy OAuth sidecar helpers consolidated, xAI
  device-code OAuth login, and recovery from stuck auth loops and stale
  release-stability stalls.
- **Forward-ported stability fixes** from the Tideclaw alpha release line.
- **Provider robustness.** Per-provider timeout overlays, per-agent local model
  lean mode, and decoding of remote URL fallback filenames.
- **Agent runtime hygiene.** Trajectory flush timeout diagnostics, recovery of
  stale subagent completion announcements, and deduplication of duplicate
  embedded run clears.

This list reflects one release line. Treat anything not listed here, and
anything in [What is not guaranteed yet](#what-is-not-guaranteed-yet), as
unconfirmed until you check the commit you are running.

## What harness and operator capabilities are included

The patch line ships the operator visibility layer that made long-running coding
work manageable. From an operator point of view you get:

- **Worker board and run view.** See every worker in a run at a glance, with
  status.
- **Status and tail.** Check a worker current state and follow its live output.
- **Heartbeat visibility.** Each worker writes periodic progress heartbeats, so
  you can tell a slow worker from a stuck one.
- **Stale and no-start detection.** Workers that never started, or stopped
  reporting, are surfaced instead of hanging silently.
- **Changed-file tracking.** See which files each worker has touched.
- **Owned-path guidance.** Each worker is scoped to a set of owned paths and
  reports when work would fall outside them.
- **Multi-worker run view.** One run can fan out to several workers; the board
  shows them together.
- **Review and landing visibility.** See which workers are in review and which
  have landed.
- **Worker-completion wake.** When a detached worker finishes, the requesting
  session is woken to review and report rather than waiting for the next poll.

Before this layer existed, a stuck worker was indistinguishable from a slow one
and long coding runs were impossible to manage. The operator workflow that uses
these capabilities is described in
[Agent harness operator workflow](#agent-harness-operator-workflow).

## What is not guaranteed yet

These are referenced by the patch set but are **not** in the dogfood line.
Confirm support before relying on them.

- **Lane pump and stall recovery.** Lives on
  `agent/lane-pump-and-stall-recovery` (commit `9d2731780`); not merged into the
  dogfood line. Run that line, or wait for the merge, if you need it.
- **Kynver first-class tools and `@kynver-app/openclaw-agent-os`.** The public
  tool seam ships in the dogfood line, but the Kynver AgentOS plugin package is
  not wired into it yet. See [Kynver first-class tools](#kynver-first-class-tools)
  and [Follow-ups](#follow-ups).
- **Operator-control pipeline and channel auto-restart.** Stale ingress
  detection and restart of running-but-nonfunctional channels live on
  `phase1-openclaw-responsiveness`; not in this line.

To check what you actually have:

```bash
git -C <checkout> rev-parse HEAD          # which commit / line
openclaw --version
openclaw plugins list --json              # which plugins loaded
openclaw doctor --lint --json             # health and config audit
```

Compare `HEAD` against the commits above to know which line you are on.

## Install

Prerequisites: an existing OpenClaw setup, Node 22.19 or newer (Node 24
recommended), and `pnpm`.

```bash
git clone https://github.com/Totalsolutionsync/openclaw.git
cd openclaw
git remote rename origin fork    # optional, keeps the source obvious
git fetch fork
git checkout <commit>            # pin to a commit, e.g. the dogfood tip
pnpm install
```

If the native image dependency fails to build (Homebrew libvips), retry with
`SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install`.

Build and deploy through the pipeline so you get atomic activation and rollback.
Choose a deploy root outside the source checkout:

```bash
node scripts/deploy-pipeline.mjs deploy --clean --deploy-root <deploy-root>
```

Then point your service start command at `<deploy-root>/current/dist/index.js`
(the symlink, never a release id) and restart the service once to adopt it. The
full mechanics, including the first cutover from a live service, are in
[Deploy pipeline](/reference/deploy-pipeline).

Verify from the active release, not a stray global install:

```bash
node <deploy-root>/current/dist/index.js --version
node <deploy-root>/current/dist/index.js doctor
```

## Update

To move to a newer patch commit:

```bash
git -C <checkout> fetch fork
git -C <checkout> checkout <new-commit>
pnpm install
node scripts/deploy-pipeline.mjs deploy --clean --deploy-root <deploy-root>
# restart the service to pick up current
```

Each deploy is a new immutable release; the previous release stays on disk for
rollback.

## Rollback

```bash
node scripts/deploy-pipeline.mjs list --deploy-root <deploy-root>
node scripts/deploy-pipeline.mjs rollback --deploy-root <deploy-root>
# restart the service
```

Rollback is the same atomic symlink swap in reverse. If a deploy looks wrong,
roll back first, then diagnose.

## Update guard: do not let stock update clobber the fork

This is the most common way to lose the patch line. Stock `openclaw update` is
built to track upstream OpenClaw, not the fork:

- `openclaw update --channel dev` checks out `main` and rebases on **upstream**,
  replacing the fork checkout.
- The stable and beta channels install the upstream npm package.

Either path overwrites the patch line. On a patched install:

- Disable automatic updates and the startup update hint in
  `~/.openclaw/openclaw.json`:

  ```json5
  {
    update: {
      checkOnStart: false,
      auto: { enabled: false },
    },
  }
  ```

- Set `OPENCLAW_NO_AUTO_UPDATE=1` in the gateway environment as a hard block
  against automatic applies.
- Update **only** through the fork remote and the deploy pipeline shown above. Do
  not run `openclaw update` on a patched install.
- If you also run stock OpenClaw, keep the patched install and the stock install
  in separate checkouts and separate deploy roots, so an update on one cannot
  touch the other.

## Kynver first-class tools

Status: the public tool seam ships in the dogfood line; the Kynver AgentOS plugin
is a follow-up (see [Follow-ups](#follow-ups)). Until that plugin is wired in,
treat Kynver first-class tools as not guaranteed on this line.

OpenClaw exposes a public agent-harness tool seam at
`openclaw/plugin-sdk/agent-harness` (with a runtime subpath for async paths). A
plugin can register a custom agent runtime that uses OpenClaw coding tools
through `createOpenClawCodingTools`, so Kynver tools run as first-class OpenClaw
tools rather than bolted-on shims. No core patch is required for the mechanism.

When the Kynver AgentOS plugin is available, install and verify it like any other
OpenClaw plugin:

```bash
openclaw plugins install @kynver-app/openclaw-agent-os
openclaw plugins list --json    # confirm it loaded and registered its tools
```

The plugin registers its tools through the seam above. Confirm the tools appear
in `openclaw plugins list` and in your agent tool list before relying on them.

## Agent harness operator workflow

The harness runs each task as one or more workers, each in an isolated git
worktree, scoped to a set of owned paths, and writing progress heartbeats. As an
operator you work from the run view and the worker board rather than from
individual processes:

- List the workers in a run and read their status.
- Tail a worker live output, and check the changed files it has produced.
- Watch heartbeats; stale or no-start workers are surfaced for you.
- See which workers are in review and which have landed.
- When a worker completes, the requesting session is woken to review and report.

This page documents what you see and do as an operator. It does not document how
the harness schedules or orchestrates workers. For the build, deploy, and
rollback mechanics that operators and workers share, see
[Deploy pipeline](/reference/deploy-pipeline).

## Support and troubleshooting

For macOS operators, in rough order of how often they come up:

- **Run doctor from the active release.** Use
  `node <deploy-root>/current/dist/index.js doctor`. A `doctor` invoked from a
  different `openclaw` still on `PATH` probes that install, not the running
  release, and can report false channel-load failures for channels the gateway
  in fact starts cleanly.
- **Restart the managed gateway** with `openclaw gateway restart` (add `--deep`
  for managed installs). Restart means rebuild, reinstall, and relaunch, not kill
  and launch. Read logs with the gateway log helper.
- **LaunchAgent installed but not loaded** after an update or deploy: run
  `openclaw gateway install --force`, then `openclaw gateway restart`.
- **Native build failures** (sharp or libvips through Homebrew):
  `SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install`.
- **pnpm or corepack bootstrap errors** on a source update: install `pnpm`
  manually (or re-enable corepack) and rerun.
- **Confirm reachability** of a running gateway:

  ```bash
  curl -fsS http://127.0.0.1:18789/readyz
  openclaw gateway status --deep --json
  ```

- **Something broke right after a patch deploy:** roll back first (it is atomic),
  restart, then diagnose from the known-good release.

## Follow-ups

These are intentionally out of scope for this docs change and need their own
branches with build, test, and review proof.

1. **Wire `@kynver-app/openclaw-agent-os` into the dogfood line.** The public
   seam (`openclaw/plugin-sdk/agent-harness`, `createOpenClawCodingTools`)
   already exists, so no core seam change is required first. The wiring adds a
   runtime dependency, lockfile churn, and plugin registration plus config
   schema, which exceeds a docs-only change and needs its own proof.
2. **Reconcile the two lines.** Merge lane pump and stall recovery
   (`agent/lane-pump-and-stall-recovery`, `9d2731780`) into the dogfood line, or
   document a single unified line. Today the release id `fork-9d273178-...` and
   the dogfood tip `d71d84f` are different lines, which is easy to confuse.
3. **Decide on phase 1 responsiveness.** Whether to fold in the operator-control
   pipeline, stale ingress detection, and channel auto-restart from
   `phase1-openclaw-responsiveness`. This is gateway runtime behavior and
   needs separate review.

## Related

- [Deploy pipeline](/reference/deploy-pipeline)
- [Updating](/install/updating)
- [Release channels](/install/development-channels)
- [Doctor](/gateway/doctor)
- [Troubleshooting](/gateway/troubleshooting)
