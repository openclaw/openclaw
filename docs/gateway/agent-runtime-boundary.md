---
title: "Agent Runtime Boundary"
description: "Guidelines for managing host-level coding agents and the boundary between temporary rescue tools and the managed Gateway runtime."
---

# Agent Runtime Boundary

The Gateway provides a managed runtime for AI coding agents. This document defines the boundary between the Gateway-managed runtime and host-level agent tooling.

## Host-level coding agents

Host-level coding-agent CLIs (e.g., `codex`, `claude`) running directly on the Gateway host are **temporary rescue tools only**. They should never be used as a permanent or long-lived agent runtime because:

- Host-level agents have broad host access beyond Gateway-managed sandbox boundaries.
- They bypass Gateway lifecycle management, authentication, and audit controls.
- Long-lived authenticated host CLI sessions accumulate state and credentials outside Gateway-managed storage.

## Managing temporary host agents

Every temporary host agent must have:

1. **An owner** — an identifiable person or team responsible for the agent.
2. **A reason** — documented justification for why the managed Gateway runtime cannot serve this need.
3. **A removal window** — a specific date or condition after which the host agent will be disabled.

## Disabling a host agent

When disabling a host-level agent, follow this sequence:

1. **Archive session state** before disabling live access. Keep raw logs and authentication material out of version control (GitHub).
2. **Remove or move live auth material** — delete or relocate `auth.json`, tokens, and credential files from the default agent home.
3. **Replace host entrypoints** with a fail-closed wrapper that exits non-zero with a refusal message, or remove them from `PATH` entirely.
4. **Verify the managed Gateway runtime** can still list and start agents after the change.
5. **Leave containerized runtimes intact** — the containerized Codex runtime and `codex-container` entrypoint are part of the managed Gateway and should not be affected.

## Cleanup policy

- Use **daily cleanup** only for clearly orphaned agent processes (processes with no live session or pending work).
- Use **more conservative cleanup** for detached terminal sessions — these may be long-running intentional sessions that the user plans to reattach to.
- Never clean up processes that are part of the managed Gateway runtime.

## Related

- [Sandboxing](/gateway/sandboxing)
- [Security](/gateway/security)
- [Operator Scopes](/gateway/operator-scopes)
- [Troubleshooting](/gateway/troubleshooting)
