# Lobster (plugin)

Adds the `lobster` agent tool as an **optional** plugin tool.

## What this is

- Lobster is a standalone workflow shell (typed JSON-first pipelines + approvals/resume).
- This plugin integrates Lobster with the OpenClaw gateway runtime.

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "lobster" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    ]
  }
}
```

## Using `openclaw.invoke` (Lobster → OpenClaw tools)

Some Lobster pipelines may include a `openclaw.invoke` step to call back into OpenClaw tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).

When Lobster runs through the bundled OpenClaw plugin, `openclaw.invoke` and
`clawd.invoke` are intercepted in process. The command uses the invoking
agent's session, channel route, account, and tool policy; it does not need a
gateway URL or bearer token.

The nested target tool must still be allowed by policy:

- `lobster` alone does not grant access to nested tools.
- A workflow that sends a channel message needs `lobster` plus `message`.
- Recursive nested `lobster` invocation is blocked.

When running the standalone Lobster CLI outside the gateway, `openclaw.invoke`
uses the gateway tool bridge endpoint instead:

- OpenClaw provides an HTTP endpoint: `POST /tools/invoke`.
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, OpenClaw returns `404 Tool not available`.

### Allowlisting recommended

To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `openclaw.invoke`.

Example (allow only a small set of tools):

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["lobster", "message", "web_fetch", "web_search", "gog", "gh"],
          "deny": ["gateway"],
        },
      },
    ],
  },
}
```

Notes:

- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.
- Tool names depend on which plugins you have installed/enabled.

## Workflow document lifecycle

The plugin registers gateway control-plane methods for storing workflow
documents:

- `lobster.workflow.publish`
- `lobster.workflow.list`
- `lobster.workflow.get`
- `lobster.workflow.delete`

These methods manage workflow documents under OpenClaw runtime state. They are
operator APIs, not agent execution APIs. Publishing a workflow does not run it
and does not grant nested OpenClaw tool access.

Use OpenClaw's existing `cron.add`, `cron.update`, and `cron.remove` gateway
methods to schedule, pause, or remove published workflow runs. A schedule should
be an `agentTurn` job that tells the target agent to invoke `lobster` with the
published workflow id:

```json
{
  "name": "lobster:daily-support",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "UTC" },
  "sessionTarget": "isolated",
  "agentId": "main",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "Run published Lobster workflow daily-support using the lobster tool.",
    "toolsAllow": ["lobster"]
  },
  "delivery": { "mode": "none" }
}
```

Scheduling does not bypass agent policy; the target agent must be allowed to use
`lobster` and any nested tools.

To run a stored workflow, invoke the existing `lobster` agent tool:

```json
{
  "action": "run",
  "workflowId": "daily-support"
}
```

The `lobster` tool also accepts `workflowYaml` for inline authoring. Inline YAML
is materialized to a runtime-state workflow file before execution. Use only one
run source per call: `pipeline`, `workflowId`, or `workflowYaml`.

Execution always goes through the `lobster` tool and the invoking agent's tool
policy. For example, a workflow that posts a channel message needs both
`lobster` and `message` allowed for that agent.

## Security

- Runs Lobster in process via the published `@clawdbot/lobster/core` runtime.
- Does not manage OAuth/tokens for embedded runtime calls.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.
