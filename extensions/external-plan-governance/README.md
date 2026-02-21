# Execution Plan Governance

A governance plugin for OpenClaw that implements execution plan as a distinct artifact that execution is bound to: before any tools execute, an LLM generates a structured execution plan. Tool calls are then validated against this plan, not in form of free-form tool calls from LLM.

The plan is the **single source of truth**. Nothing executes unless it's in the plan.

## How It Works

1. `before_request` hook intercepts user message
2. Call LLM with message + schema → get structured plan
3. Store plan (keyed by `runId`)
4. If `execution_mode: "preview"` → show plan, block execution

## The Schema

Plans follow a simple schema (`execution-plan.schema.json`). Required fields are:

```json
{
  "description_for_user": "Delete old log files",
  "five_w_one_h": {
    "who": "system",
    "what": "remove files matching *.log older than 7 days",
    "where": "/var/log",
    "when": "immediate",
    "why": "free disk space",
    "how": "find + rm"
  },
  "procedure": [
    { "step": 1, "action": "find files matching *.log older than 7 days" },
    { "step": 2, "action": "delete matched files" }
  ],
  "surface_effects": {
    "touches": ["/var/log"],
    "modifies": false,
    "creates": false,
    "deletes": true
  },
  "constraints": ["do not delete files newer than 7 days"],
  "execution_mode": "preview"
}
```

## Configuration

```json
{
  "extensions": {
    "execution-plan-governance": {
      "enabled": true,
      "defaultMode": "preview",
      "failOpen": false
    }
  }
}
```

## Integration with #6095

Uses hooks from [PR #6095](https://github.com/openclaw/openclaw/pull/6095):

- `before_request`: Generate plan

Complements security guardrails: they block _dangerous_ calls, this blocks _unplanned_ calls.

## License

MIT
