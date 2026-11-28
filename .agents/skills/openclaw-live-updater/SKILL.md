---
name: openclaw-live-updater
description: "Maintain the canonical live OpenClaw main checkout, macOS LaunchAgent-managed Gateway, local macOS app, exact-head main CI, and recurring full release validation. Use for fast-forward update heartbeats, post-update runtime verification, attributable CI repair and repo-native landing, or non-publishing Full Release Validation of current main. Do not use on Linux systemd Gateways."
---

# OpenClaw Live Updater

Keep one operator-selected canonical live checkout as a read-only-to-the-agent deployment mirror: clean, standalone, full, on `main`, and fast-forwarded only. Make every repair in the controlling Codex project worktree.

## Boundaries

- Report only in the controlling Codex thread. Never send Slack, Discord, email, or other external messages.
- Never release, tag, bump versions, publish npm, create a GitHub Release, rotate credentials, or weaken a gate.
- Escalate only irreversible or materially risky security, privacy, auth, destructive migration/data-loss, protocol-version, credential-rotation, dependency patch/override, or product choices.
- Diagnose ordinary update, runtime, app, CI, test, and release-validation failures; fix them through a focused PR; prove exact head; land with `scripts/pr`.
- Never edit, stash, reset, clean, or create a branch in the live mirror.
- Never use `launchctl submit` or create an ad-hoc KeepAlive job to run updates or Gateway lifecycle commands. A submitted job can relaunch `openclaw gateway restart` after every exit and cause a persistent restart storm, even without a plist ([#114967](https://github.com/openclaw/openclaw/issues/114967)).

## Fast Update And Maintenance

Before updating or maintaining the live checkout, Gateway, or app, or accepting
maintenance proof, read [the maintenance procedure](references/maintenance.md) in full.

## Full Release Validation

Before scheduling, running, recovering, or accepting full validation, read
[the full-validation procedure](references/full-validation.md) in full.
For source repairs and PR landing, also read
[the maintenance procedure](references/maintenance.md) in full.

## Failure Discipline

- Recheck live mirror invariants before every mutation and after every fetch.
- Attribute failures from exact SHA, job, logs, and current source. Provider or infrastructure flakes need independent proof before code edits.
- Keep the task branch focused. No `CHANGELOG.md` change.
- Finish with the mirror clean/on `main`, the Codex worktree clean on the expected branch, remote Testbox stopped, and every public GitHub write linked in the controlling thread.
