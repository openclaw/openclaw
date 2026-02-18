---
summary: "Pre-spawn context scripts: inject identity, context, or metadata into sub-agent tasks before execution"
title: Context Scripts
read_when:
  - Configuring pre-spawn hooks for sub-agents
  - Injecting identity or context into spawned sessions
  - Dynamically overriding the target agent at spawn time
status: active
---

# Context Scripts

Context scripts run **before** a sub-agent session is spawned via `sessions_spawn`. They can inject context (identity files, charters, instructions) into the task message and optionally override which agent the session runs under.

## Why?

When spawning sub-agents, only `AGENTS.md` and `TOOLS.md` are included by default. Identity files like `SOUL.md`, `IDENTITY.md`, or custom governance documents are not passed through. Context scripts solve this by running a script that resolves the right context for the target agent and injects it into the task.

They also solve a common multi-agent pattern: **unregistered agent aliases**. If you have lightweight agent roles (e.g. specialist personas under a parent agent), context scripts can detect the alias, inject the right identity, and redirect the spawn to the parent agent for auth and model resolution.

## How It Works

1. Agent calls `sessions_spawn` with a `targetAgentId` and `task`
2. Context scripts execute **before** auth, config, and session key resolution
3. Each script receives spawn variables (agent ID, task, label, etc.) as arguments or JSON
4. Script output is parsed and prepended/appended to the task message
5. If a script returns an `agentIdOverride`, the target agent is swapped before auth resolution
6. The overridden agent ID is validated against the gateway config — only real, configured agents are accepted

## Configuration

Context scripts are configured at two levels:

### Global Defaults

Applied to all `sessions_spawn` calls:

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "contextScripts": {
          "run": [
            {
              "id": "my-identity-script",
              "uri": "~/scripts/inject-identity.sh",
              "format": "arguments",
              "priority": 100,
              "position": "prepend",
              "log": true,
              "errorHandling": "continue",
              "returnKey": "message",
              "agentIdOverrideKey": "targetAgentId",
              "argMap": {
                "targetAgentId": "targetAgentId"
              }
            }
          ]
        }
      }
    }
  }
}
```

### Per-Agent Overrides

Add scripts or ignore global ones for a specific agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "my-agent",
        "subagents": {
          "contextScripts": {
            "run": [
              {
                "id": "agent-specific-script",
                "uri": "https://example.com/api/context",
                "format": "json",
                "method": "POST",
                "priority": 50
              }
            ],
            "ignore": ["my-identity-script"]
          }
        }
      }
    ]
  }
}
```

### Resolution Order

1. Start with `defaults.subagents.contextScripts.run[]`
2. Remove any IDs listed in `agent.subagents.contextScripts.ignore[]`
3. Append `agent.subagents.contextScripts.run[]`
4. Deduplicate by `id` (agent-specific entries override defaults with the same ID)
5. Sort by `priority` (highest first, stable sort)

## Script Entry Schema

| Field                | Type                         | Default       | Description                                                                |
| -------------------- | ---------------------------- | ------------- | -------------------------------------------------------------------------- |
| `id`                 | `string`                     | _required_    | Unique identifier for dedup and ignore lists                               |
| `uri`                | `string`                     | _required_    | File path or HTTP(S) URL                                                   |
| `format`             | `"arguments" \| "json"`      | `"arguments"` | How variables are passed to the script                                     |
| `method`             | `string`                     | `"GET"`       | HTTP method (only for URL scripts)                                         |
| `priority`           | `number`                     | `0`           | Execution/sort order. Higher runs first. Negative values OK.               |
| `position`           | `"prepend" \| "append"`      | `"append"`    | Where to inject output in the task message                                 |
| `log`                | `false \| true \| "verbose"` | `false`       | `false`: silent. `true`: summary line. `"verbose"`: full command + output. |
| `errorHandling`      | `"continue" \| "stop"`       | `"continue"`  | What to do when the script fails                                           |
| `returnKey`          | `string`                     | —             | Extract this key from JSON output as the content to inject                 |
| `errorKey`           | `string`                     | —             | Check this key in JSON output for error conditions                         |
| `agentIdOverrideKey` | `string`                     | —             | Extract this key from JSON output to override the target agent ID          |
| `argMap`             | `Record<string, string>`     | —             | Map spawn variables to script arguments                                    |

## Variable Passing

### Format: `arguments`

Variables from `argMap` are passed as CLI arguments in `key="value"` format:

```bash
~/scripts/inject-identity.sh targetAgentId="my-agent"
```

### Format: `json`

Variables from `argMap` are passed as a JSON object on stdin:

```json
{ "targetAgentId": "my-agent" }
```

### Available Variables

These are the spawn variables available for mapping via `argMap`. The key in `argMap` becomes the argument name; the value must be one of these variable names.

| Variable              | Type                              | Description                                                                                                                                                                             |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targetAgentId`       | `string`                          | The requested agent ID (before any override). This is the `agentId` passed to `sessions_spawn`, or the requester's own agent ID if none was specified.                                  |
| `task`                | `string`                          | The raw task message as provided by the caller (before any context script injection).                                                                                                   |
| `label`               | `string \| undefined`             | The spawn label, if provided. Useful for display, logging, or routing decisions in the script.                                                                                          |
| `requesterAgentId`    | `string`                          | The agent ID of the session that called `sessions_spawn`.                                                                                                                               |
| `requesterSessionKey` | `string \| undefined`             | The full session key of the requester (e.g. `agent:my-agent:telegram:direct:12345`).                                                                                                    |
| `cleanup`             | `"delete" \| "keep" \| undefined` | Session cleanup mode. `"delete"` removes the session after completion; `"keep"` preserves it.                                                                                           |
| `cfg`                 | `object`                          | The full gateway configuration object. Only useful with `format: "json"` — allows scripts to inspect agent config, model settings, etc. Large; avoid passing via `format: "arguments"`. |

**Example `argMap` configurations:**

Pass just the target agent:

```json
{
  "argMap": {
    "targetAgentId": "targetAgentId"
  }
}
```

→ Script receives: `targetAgentId="my-agent"`

Pass multiple variables:

```json
{
  "argMap": {
    "agent": "targetAgentId",
    "spawner": "requesterAgentId",
    "tag": "label"
  }
}
```

→ Script receives: `agent="my-agent" spawner="parent-agent" tag="my-label"`

Note: The `argMap` key is the **argument name** the script sees; the value is the **variable name** from the table above. This lets you rename variables to match your script's expectations.

## Script Output

### Plain Text

If the script outputs plain text (not JSON), it's used as-is for injection.

### JSON Output

If the script outputs JSON, the response parsing pipeline processes it:

1. If `errorKey` is set and that key exists in the output → treated as an error
2. Standard error detection (OpenAI/Anthropic/REST error patterns)
3. If `returnKey` is set → extract that key as the content
4. If `agentIdOverrideKey` is set → extract that key as the agent ID override
5. Auto-detect common content keys: `message`, `content`, `text`, `result`
6. Fallback: stringify the entire object

Example JSON output from a script:

```json
{
  "message": "## Identity\n\nYou are the High Steward...",
  "targetAgentId": "parent-agent",
  "spawnType": "unregistered",
  "agentName": "parent-agent",
  "subAgentName": "steward"
}
```

With `returnKey: "message"` and `agentIdOverrideKey: "targetAgentId"`, the system extracts `"## Identity\n\nYou are the High Steward..."` as prepend content and overrides the agent to `"parent-agent"`.

## Agent ID Override

The `agentIdOverrideKey` feature enables **dynamic agent resolution** at spawn time. This is useful when:

- You have lightweight agent roles (personas, specialists) that aren't full registered agents
- The script knows which parent agent should handle auth and model resolution
- You want to spawn by role name and let the script resolve the runtime agent

### Validation

Override candidates are validated against the gateway config. Only agent IDs that resolve to a configured agent (with auth credentials) are accepted. If no valid override is found, the original `targetAgentId` is used.

### Multi-Script Conflict Resolution

When multiple scripts propose different overrides:

1. Candidates are collected with their script ID and priority
2. Each candidate is validated against the gateway config
3. The **highest-priority valid candidate** wins (scripts are already sorted by priority)
4. If no candidate is valid, the original agent ID is preserved

Verbose logging shows all candidates with validation status:

```
[context-script] agentIdOverride candidates: [script-a→agent-x (pri:100 ✓), script-b→agent-y (pri:50 ✗)] → winner: script-a→agent-x
```

## Logging

| Level       | Output                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `false`     | Silent — no log output                                                        |
| `true`      | Summary: `[context-script] my-script (~/path) → 2821 chars`                   |
| `"verbose"` | Full command with resolved args, full output, override candidates, and winner |

## Error Handling

| Mode         | Behavior                                                                           |
| ------------ | ---------------------------------------------------------------------------------- |
| `"continue"` | Log warning, skip this script, continue with remaining scripts                     |
| `"stop"`     | Log warning, stop executing remaining scripts (content from prior scripts is kept) |

If a script produces no output (empty string), it's silently skipped — no content is injected. This makes scripts safe as no-ops when they have nothing to contribute.

## Example: Identity Injection Script

A shell script that resolves agent identity based on an agent topology:

```bash
#!/usr/bin/env bash
# inject-identity.sh — resolve agent identity for spawning

AGENT_ID=""
for arg in "$@"; do
  case "$arg" in
    targetAgentId=*) AGENT_ID="${arg#targetAgentId=}" ;;
  esac
done

# Check if this is a registered agent or an alias
if is_registered "$AGENT_ID"; then
  MESSAGE=$(cat "agents/$AGENT_ID/SOUL.md")
  echo "{\"message\": $(echo "$MESSAGE" | jq -Rs .), \"targetAgentId\": \"$AGENT_ID\"}"
elif is_alias "$AGENT_ID"; then
  PARENT=$(resolve_parent "$AGENT_ID")
  CHARTER=$(cat "agents/$AGENT_ID/charter.md")
  echo "{\"message\": $(echo "$CHARTER" | jq -Rs .), \"targetAgentId\": \"$PARENT\"}"
else
  # Unknown agent — no-op (empty output)
  exit 0
fi
```

## Execution Flow

```
sessions_spawn(agentId: "steward", task: "Review the architecture")
    │
    ├─ Resolve context scripts (defaults + agent overrides)
    ├─ Execute scripts in priority order
    │   ├─ Script returns: { message: "## Charter...", targetAgentId: "main-agent" }
    │   ├─ Extract content → prepend to task
    │   └─ Extract override → candidate: main-agent (pri:100)
    │
    ├─ Validate override candidates against config
    │   └─ main-agent → resolveAgentConfig() ✓
    │
    ├─ Apply override: targetAgentId = "main-agent"
    │
    ├─ Auth resolution (uses "main-agent" credentials) ✓
    ├─ Build childSessionKey: agent:main-agent:subagent:<uuid>
    ├─ Resolve model + thinking from "main-agent" config
    │
    └─ Spawn session with prepended task:
        "## Charter...\n\nReview the architecture"
```
