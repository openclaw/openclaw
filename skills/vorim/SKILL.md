---
name: vorim
description: "AI agent identity, permissions, trust scores, and audit trails via Vorim AI. Use when: (1) performing sensitive actions that need permission checks, (2) logging agent actions for audit trails, (3) verifying agent identity or trust score, (4) registering a new agent. Requires mcporter with @vorim/mcp-server configured."
homepage: https://vorim.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "primaryEnv": "VORIM_API_KEY",
        "requires": { "bins": ["mcporter"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# Vorim AI — Agent Identity & Trust

Use Vorim to give your agent a cryptographic identity, enforce permissions before actions, log an audit trail, and verify trust scores.

## Setup

1. Get a free API key at https://vorim.ai
2. Set the environment variable: `VORIM_API_KEY=agid_sk_live_...`
3. Add the MCP server: `mcporter config add vorim --stdio "npx -y @vorim/mcp-server"`

## When to Use

✅ **USE this skill when:**

- About to perform a sensitive or destructive action (shell commands, sending emails, making payments)
- Logging what the agent did for accountability
- Proving your identity to an external service or another agent
- Registering this agent for the first time
- Checking if you have permission to do something

❌ **DON'T use this skill for:**

- Read-only browsing or simple queries (no permission check needed)
- Actions the user is performing directly (Vorim tracks agent actions, not human actions)

## Quick Reference

```bash
# Check available tools
mcporter list vorim --schema

# Register this agent (first run only)
mcporter call vorim.vorim_register_agent name="my-openclaw" capabilities:='["browse","email","shell"]' scopes:='["agent:read","agent:write","agent:execute"]'

# Check permission before an action
mcporter call vorim.vorim_check_permission agent_id="agid_..." scope="agent:execute"

# Log an action
mcporter call vorim.vorim_emit_event agent_id="agid_..." event_type="tool_call" action="send_email" result="success"

# Verify trust score
mcporter call vorim.vorim_verify_trust agent_id="agid_..."

# List all agents
mcporter call vorim.vorim_list_agents
```

## Permission Scopes

Check the appropriate scope before taking action:

| Scope | When to check |
|-------|--------------|
| `agent:read` | Browsing, searching, reading files or data |
| `agent:write` | Creating files, editing data, sending messages |
| `agent:execute` | Running shell commands, scripts, automations |
| `agent:transact` | Making purchases, payments, financial actions |
| `agent:communicate` | Sending emails, posting to social media, messaging |
| `agent:delegate` | Granting permissions to other agents |
| `agent:elevate` | Escalating privileges beyond current level |

## Available Tools (17)

| Tool | Purpose |
|------|---------|
| `vorim_ping` | Check API connectivity |
| `vorim_register_agent` | Register this agent with an Ed25519 keypair |
| `vorim_get_agent` | Get agent details by ID |
| `vorim_list_agents` | List all agents in the organisation |
| `vorim_update_agent` | Update agent name, status, or capabilities |
| `vorim_revoke_agent` | Permanently revoke an agent |
| `vorim_check_permission` | Check if an action is allowed (sub-5ms) |
| `vorim_grant_permission` | Grant a permission with optional expiry and rate limits |
| `vorim_list_permissions` | List active permissions for an agent |
| `vorim_revoke_permission` | Revoke a permission |
| `vorim_emit_event` | Log a tamper-evident audit event |
| `vorim_export_audit` | Export a signed audit bundle (SHA-256 manifest) |
| `vorim_verify_trust` | Verify agent identity and trust score (0-100) |
| `vorim_register_ephemeral` | Create a short-lived agent with did:key identity |
| `vorim_delegate_credential` | Delegate a scoped credential to another agent |
| `vorim_request_token` | Request a short-lived access token |
| `vorim_list_delegations` | List credential delegations |

## Behavioral Rules

1. **Always check permission before destructive or external actions** — protects the user from unintended agent behavior
2. **Always log actions with `vorim_emit_event`** — the audit trail is the user's proof of what happened
3. **If permission is denied, stop and inform the user** — do not attempt the action or try to work around it
4. **Register once on first use** — save the `agent_id` for all future operations
5. **Share your trust score when asked** — transparency builds user confidence
