---
name: consentguard
description: Understand and guide users on ConsentGuard (exec approvals, allowlists, gate audit). Use when users ask about pending approvals, adding commands to allowlists, approval policy, or compliance audit.
metadata: { "openclaw": { "emoji": "🛡️" } }
---

# ConsentGuard

Human-in-the-loop (HITL) for exec and other high-risk tool use. When ConsentGuard is enabled, certain tool calls require operator approval before they run.

## When to use this skill

- User asks about "pending approval", "exec approval", "allowlist", or "ConsentGuard"
- User wants to allow or deny a command that is waiting for approval
- User wants to add a command pattern to the allowlist so it no longer prompts
- User asks about approval policy (security mode, ask mode, timeouts)
- User needs a compliance or audit trail of approved/denied actions
- User is confused why a command did not run (may be waiting for approval)

## Core concepts

1. **Pending requests** — When the agent uses the `exec` tool (or other gated tools) and the action is not on the allowlist, the gateway emits an approval request. Operators see it in the Control UI (ConsentGuard Hub) or in channel notifications (e.g. Discord). The request includes: command, cwd, host, agent, session, and expiry.

2. **Decisions** — Operator can:
   - **Allow once** — Run this time only.
   - **Allow always** — Add to allowlist (pattern) so future matching commands run without prompt.
   - **Deny** — Reject; the tool call fails for the agent.

3. **Policy** — Gateway and per-node exec approval config:
   - **Security**: `deny` (no exec), `allowlist` (only allowlisted), `full` (no gate).
   - **Ask**: `off`, `on-miss` (prompt when not on allowlist), `always` (always prompt).
   - **Allowlist** — Glob-style patterns; case-insensitive match on command line.

4. **Gate audit** — Read-only log of approved/denied actions for compliance. Exposed in the Control UI when the gateway supports it.

## What the agent can and cannot do

- **Cannot** resolve approvals itself; only an operator (human or client with approvals scope) can call `exec.approval.resolve`.
- **Can** explain why a command is pending and how to approve or deny it in the Control UI.
- **Can** suggest adding a pattern to the allowlist when the user agrees a command is safe to run repeatedly.
- **Can** guide the user to open the dashboard → Mission Control → ConsentGuard to see the pending queue and policy.
- **Can** run read-only checks (e.g. `openclaw status`) that do not require exec approval.

## Guiding users

1. **"A command is waiting for approval"**  
   Tell the user to open the OpenClaw dashboard, turn on **Mission Control** in the sidebar if needed, go to **ConsentGuard**, and use the Pending requests section to Allow once, Allow always, or Deny. If they use Discord or another channel with approval notifications, they can approve there.

2. **"How do I allow this command every time?"**  
   After they approve once, suggest they use **Allow always** on the same request next time, or add the pattern in ConsentGuard → Policy → Allowlist (per-agent or defaults). Patterns are glob-style (e.g. `npm run *`).

3. **"Where is the audit log?"**  
   In the dashboard: Mission Control → ConsentGuard → Gate audit. If the gateway does not yet expose an audit API, the section will say so.

4. **"Why was my command denied?"**  
   Exec approval may be denied by the operator, or the request may have expired. Check Gate audit for the record. If security mode is `deny`, no exec runs until policy is changed.

## Policy locations

- **Gateway** — Applies to exec on the gateway host. Edited in Control UI: Nodes (or ConsentGuard) → Exec approvals → Target: Gateway.
- **Node** — Per-node policies when exec runs on a remote node. Target: Node, then select the node. Requires the node to support `exec.approvals.node.get` / `exec.approvals.node.set`.

## References

- Dashboard: Mission Control → ConsentGuard (pending queue, policy, allowlist, gate audit).
- Docs: https://docs.openclaw.ai/web/control-ui
- Exec approvals are configured per-agent scope (defaults vs specific agent) and per target (gateway vs node).
