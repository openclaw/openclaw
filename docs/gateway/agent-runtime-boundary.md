---
summary: "Keep privileged coding agents inside the managed Gateway runtime"
read_when:
  - Installing or removing host-level coding agent CLIs
  - Auditing a Gateway host after bootstrap or recovery work
  - Moving temporary rescue agents back into the managed runtime
title: "Agent Runtime Boundary"
---

# Agent Runtime Boundary

OpenClaw should run coding agents from the managed Gateway runtime by default. Avoid keeping a second host-level agent CLI available on the same Gateway host unless it has a current bootstrap or recovery purpose.

## Decision

Use the managed Gateway runtime as the normal execution boundary for Codex, Claude, and similar coding agents.

Host-level agent CLIs are allowed only as temporary rescue tools. They must have an owner, a reason, and a removal window. When the rescue window ends, disable the host CLI and remove its live authentication material.

## Why this boundary exists

A host-level coding agent can see host files, host process state, network credentials, and container controls that the managed runtime may intentionally isolate. Even when the agent is trusted, leaving an extra authenticated CLI on the host expands the recovery surface and makes orphaned sessions harder to reason about.

The safer default is:

- one managed runtime for normal agent work
- no long-lived host-level authenticated agent CLI
- explicit session archival before removal
- documented changes outside the host being changed

## Temporary host-agent checklist

Before installing a host-level agent CLI:

1. Record the reason and owner.
2. Prefer a dedicated profile, state directory, or temporary home.
3. Avoid sharing credentials with the managed runtime.
4. Set an expiry date for the host-level install.
5. Document the planned removal path before using it for production recovery.

Before disabling a host-level agent CLI:

1. Archive session state to an operator-controlled location.
2. Do not commit raw session logs, auth files, shell snapshots, or credentials.
3. Remove or move live auth material out of the default agent home.
4. Replace the host CLI with a refusal wrapper or remove it from `PATH`.
5. Verify the host CLI fails closed.
6. Verify the managed runtime still starts agents normally.
7. Commit the decision or runbook update to GitHub.

## What to archive

Archive enough thread state to reconstruct the operational history:

- session JSONL files
- local history or state indexes when needed for lookup
- a checksum for the archive
- the timestamp and operator who created it

Do not archive live auth tokens into GitHub. If raw session logs may contain secrets or private user data, keep the archive in an operator-controlled backup location and document only the checksum and storage owner in GitHub.

## Disable pattern

The safest host-level disable pattern is fail-closed:

```bash
command -v codex
codex_path="$(command -v codex)"
codex_dir="$(dirname "$codex_path")"
mv "$codex_path" "$codex_dir/codex.host-disabled-$(date -u +%Y%m%dT%H%M%SZ)"
install -m 0755 ./host-agent-disabled-wrapper "$codex_dir/codex"
codex --version
```

The replacement command should exit non-zero and explain that operators must use the managed Gateway runtime instead.

If the host-level agent has a separate real binary or symlink such as `codex-real`, disable that entrypoint too. Removing only the outer wrapper is not enough when other scripts can call the inner binary directly.

## Verification

After disabling the host-level CLI:

```bash
codex --version
openclaw agents list
openclaw status --deep
```

Expected result:

- the host-level CLI refuses to run
- the Gateway can still list and start managed agents
- no host-level agent processes remain unless they are explicitly attached to an active rescue session

## Recurring cleanup

Use conservative cleanup jobs for agent hosts:

- daily cleanup for clearly orphaned coding-agent processes
- less frequent cleanup for detached terminal multiplexers
- no automatic removal of attached sessions
- no deletion of raw session archives

Detached terminal sessions should be killed only after an idle threshold long enough for real recovery use. A 48 hour threshold is a reasonable starting point for `tmux` sessions that are detached and named for temporary agent access.
