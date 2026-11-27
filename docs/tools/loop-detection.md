---
summary: "How the tool repeat guard stops identical tool-call loops"
title: "Tool-loop detection"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to control repetitive-call protection
  - You are editing agent tool/runtime policies
  - You see a `tool_repeat_limit` stop
---

The tool repeat guard stops a model that calls the same tool with the same
arguments again and again. It is on by default.

## How it works

The guard compares each tool call with the call before it. It compares only the
tool name and the canonical arguments (key order does not matter). It never
compares results, so a repeated failing call and a repeated successful call
count the same way.

- **3rd identical call in a row:** the call runs. OpenClaw adds a system note to
  its result that names the tool and tells the model to change its approach.
- **20th identical call in a row:** the call does not run. OpenClaw ends the
  turn with the typed reason `tool_repeat_limit` and shows this message:
  `OpenClaw stopped this turn: the model called <tool> with the same arguments 20 times in a row. Send a new message to continue.`

A different call resets the count. New user input also resets it.

A call to an unavailable tool counts by name only, so a model that keeps trying
a missing tool with changing arguments still reaches the note and the stop.

### Tools that repeat by design

Some tools poll or wait, so identical calls are expected. These tools declare
`repeatable` and the guard skips them:

- `wait` (Code Mode)
- `process` with `poll`, `log` or `list`
- `agents_wait`, `sessions_yield`, and `subagents` with `list` or `wait`
- `computer` with `screenshot` or `wait`

A plugin tool can declare `repeatable: true`, or `repeatable: { actions: [...] }`
to skip only calls whose `action` argument is listed.

Worker turns (cloud and node workers) run the same guard over all their tools and
follow the same `tools.loopDetection.enabled` setting.

## Configuration

Global setting:

```json5
{
  tools: {
    loopDetection: {
      enabled: false, // turn the repeat guard off (default: on)
    },
  },
}
```

Per-agent override (optional, at `agents.entries.*.tools.loopDetection`):

```json5
{
  agents: {
    entries: {
      "safe-runner": {
        tools: {
          loopDetection: {
            enabled: true,
          },
        },
      },
    },
  },
}
```

The per-agent setting overrides the global setting.

| Field     | Default | Effect                                         |
| --------- | ------- | ---------------------------------------------- |
| `enabled` | `true`  | Set `false` to turn the tool repeat guard off. |

Older loop-detection keys (`warningThreshold`, `criticalThreshold`,
`detectors`, `postCompactionGuard` and similar) are retired; `openclaw doctor --fix`
removes them.

## Logs

Each note and each stop writes a `tool loop:` diagnostic line and a `tool.loop`
diagnostic event with `detector=tool_repeat`. A note uses `action=warn`; a stop
uses `action=block`.

## Related

<CardGroup cols={2}>
  <Card title="Exec approvals" href="/tools/exec-approvals" icon="shield">
    Allow/deny policy for shell execution.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    Reasoning effort levels and provider-policy interaction.
  </Card>
  <Card title="Sub-agents" href="/tools/subagents" icon="users">
    Spawning isolated agents to bound runaway behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-tools#tools-loopdetection" icon="gear">
    Full `tools.loopDetection` schema and merging semantics.
  </Card>
</CardGroup>
