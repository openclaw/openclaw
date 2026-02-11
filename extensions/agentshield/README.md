# AgentShield OpenClaw Extension

This extension implements a `before_tool_call` hook that calls an AgentShield trust server and maps the decision to:

- allow (tool executes)
- block (tool does not execute)
- needs approval (tool does not execute; core returns `{ status: "approval-pending" }`)

## Enable

Set:

- `AGENTSHIELD_APPROVALS_ENABLED=1`

## Configure

- `AGENTSHIELD_URL` — base URL for the AgentShield trust server
- `AGENTSHIELD_MODE` — `all` (default) or `selective`
- `AGENTSHIELD_TOOLS` — comma-separated tool-name allowlist (used when mode is `selective`)

## Behavior

When enabled, the extension runs before each tool call and returns:

- `{ block: true, blockReason }` to block
- `{ needsApproval: true, approvalReason }` to require operator approval
- `undefined` to allow
