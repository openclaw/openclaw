---
summary: "MCP/plugin tool call approvals, allowlists, and policy configuration"
read_when:
  - Configuring MCP tool approvals or allowlists
  - Gating MCP/plugin tool calls with operator approval
  - Restricting which MCP tools agents can invoke
title: "Tool Approvals"
---

# Tool approvals

Tool approvals gate **MCP and plugin tool calls** with the same security/ask/askFallback pattern
used by [exec approvals](/tools/exec-approvals) and HTTP approvals.

By default the policy is **permissive** (`security: full`, `ask: off`) so existing
deployments are unaffected. Operators can tighten the policy per-gateway or per-agent.

## Config

Tool approval policy lives under `approvals.toolPolicy` in the OpenClaw config:

```yaml
approvals:
  toolPolicy:
    # "deny" | "allowlist" | "full" (default: "full")
    security: allowlist

    # "off" | "on-miss" | "always" (default: "off")
    ask: on-miss

    # fallback when no operator responds (default: "full")
    askFallback: deny

    # tool name patterns (glob-style)
    allowlist:
      - pattern: "github__list_*"
      - pattern: "github__get_*"
      - pattern: "slack__send_*"

    # per-agent overrides
    agents:
      ops:
        security: deny
      research:
        security: allowlist
        allowlist:
          - pattern: "web_search"
          - pattern: "web_fetch"
```

## Policy resolution

1. `approvals.toolPolicy` sets global defaults.
2. `approvals.toolPolicy.agents.<agentId>` overrides per agent.
3. `approvals.toolPolicy.agents.*` provides wildcard agent defaults (per-agent values take priority).
4. Built-in defaults: `security=full`, `ask=off`, `askFallback=full`.

## Security modes

| Mode        | Behavior                                             |
| ----------- | ---------------------------------------------------- |
| `full`      | Allow all tool calls (default).                      |
| `allowlist` | Allow only tool calls matching an allowlist pattern. |
| `deny`      | Deny all tool calls.                                 |

## Ask modes

| Mode      | Behavior                                                     |
| --------- | ------------------------------------------------------------ |
| `off`     | Never prompt the operator (default).                         |
| `on-miss` | Prompt only when the tool name does not match the allowlist. |
| `always`  | Always prompt, even on allowlist match.                      |

## Allowlist patterns

Patterns use glob-style matching against the full tool name:

- `*` matches any characters
- `?` matches a single character
- Matching is case-insensitive

Examples:

| Pattern          | Matches                                     |
| ---------------- | ------------------------------------------- |
| `github__list_*` | `github__list_repos`, `github__list_issues` |
| `github__*`      | Any tool from the `github` MCP server       |
| `*__read_*`      | Any read tool across all servers            |
| `exec__*`        | Any exec-prefixed tool                      |
| `*`              | Everything (equivalent to `security: full`) |

## Forwarding to chat channels

Tool approval requests can be forwarded to chat channels for operator response,
similar to exec approval forwarding:

```yaml
approvals:
  tool:
    enabled: true
    mode: session # "session" | "targets" | "both"
    targets:
      - channel: telegram
        to: "123456789"
```

## Gateway events

| Event                     | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `tool.approval.requested` | Emitted when a tool call requires approval.    |
| `tool.approval.resolved`  | Emitted when an approval is granted or denied. |

## Gateway RPC methods

| Method                       | Description                                                  |
| ---------------------------- | ------------------------------------------------------------ |
| `tool.approval.request`      | Register a pending tool approval request.                    |
| `tool.approval.waitDecision` | Wait for an operator decision on a pending request.          |
| `tool.approval.resolve`      | Resolve a pending approval (allow-once, allow-always, deny). |
