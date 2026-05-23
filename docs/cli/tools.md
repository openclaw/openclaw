---
summary: "CLI reference for `openclaw tools` (Gateway tool plan execution)"
read_when:
  - You want to replay a model-selected tool plan through the Gateway boundary
  - You need deterministic tool dispatch for integration tests
  - You want every planned tool call to run through `tools.invoke`
title: "Tools"
---

# `openclaw tools`

Tool helpers for deterministic Gateway tool execution.

## `tools execute-plan`

Execute a JSON tool plan step-by-step through the Gateway `tools.invoke`
boundary. Each step is invoked as a normal Gateway tool call, so the existing
tool resolution, approval, policy, and `before_tool_call` hook path runs before
the tool body.

```bash
openclaw tools execute-plan plan.json --json
openclaw tools execute-plan --file plan.json --session-key agent:main:main
```

Plan files can be either an array or an object with a `steps` array:

```json
{
  "steps": [
    { "action": "openclaw.version", "input": {} },
    { "action": "deploy.production", "input": { "service": "api" } }
  ]
}
```

Step fields:

- `action`, `name`, or `tool`: tool name to invoke.
- `input`, `args`, or `arguments`: tool arguments object.

By default, execution stops at the first blocked or failed tool. Use
`--continue-on-error` to continue replaying the rest of the plan.

Flags:

- `--file <path>`: JSON plan path. You can also pass the path as the first
  positional argument.
- `--continue-on-error`: continue after blocked or failed steps.
- `--session-key <sessionKey>`: target a specific session for tool
  policy/context resolution.
- `--agent-id <agentId>`: target a specific agent.
- `--confirm`: request approval instead of only reporting approval
  requirements.
- `--json`: machine-readable output.
- `--url`, `--token`, `--timeout`, `--expect-final`: shared Gateway RPC flags.

## Output

JSON output includes a top-level plan result and per-step status:

```json
{
  "ok": false,
  "stopped": true,
  "stopReason": "blocked_tool",
  "steps": [
    {
      "index": 0,
      "action": "openclaw.version",
      "status": "completed",
      "durationMs": 12,
      "source": "core"
    },
    {
      "index": 1,
      "action": "deploy.production",
      "status": "blocked",
      "durationMs": 4,
      "error": {
        "code": "forbidden",
        "message": "tool call blocked"
      }
    }
  ]
}
```

## Notes

- Requires a running Gateway reachable by your current config, `--url`, or
  gateway remote settings.
- The command does not bypass tool policy. Unknown, blocked, or approval-gated
  tools are reported as blocked or failed results and stop the plan unless
  `--continue-on-error` is set.

## Related

- [Gateway tools.invoke HTTP API](/gateway/tools-invoke-http-api)
- [CLI reference](/cli)
