---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Sub-agents: spawning isolated agent runs that announce results back to the requester chat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want background/parallel work via the agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are changing sessions_spawn or sub-agent tool policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Sub-Agents"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sub-Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agents let you run background tasks without blocking the main conversation. When you spawn a sub-agent, it runs in its own isolated session, does its work, and announces the result back to the chat when finished.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Use cases:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Research a topic while the main agent continues answering questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run multiple long tasks in parallel (web scraping, code analysis, file processing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delegate tasks to specialized agents in a multi-agent setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The simplest way to use sub-agents is to ask your agent naturally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> "Spawn a sub-agent to research the latest Node.js release notes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent will call the `sessions_spawn` tool behind the scenes. When the sub-agent finishes, it announces its findings back into your chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can also be explicit about options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> "Spawn a sub-agent to analyze the server logs from today. Use gpt-5.2 and set a 5-minute timeout."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How It Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Main agent spawns">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    The main agent calls `sessions_spawn` with a task description. The call is **non-blocking** — the main agent gets back `{ status: "accepted", runId, childSessionKey }` immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Sub-agent runs in the background">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    A new isolated session is created (`agent:<agentId>:subagent:<uuid>`) on the dedicated `subagent` queue lane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Result is announced">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    When the sub-agent finishes, it announces its findings back to the requester chat. The main agent posts a natural-language summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Session is archived">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    The sub-agent session is auto-archived after 60 minutes (configurable). Transcripts are preserved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each sub-agent has its **own** context and token usage. Set a cheaper model for sub-agents to save costs — see [Setting a Default Model](#setting-a-default-model) below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agents work out of the box with no configuration. Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model: target agent’s normal model selection (unless `subagents.model` is set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thinking: no sub-agent override (unless `subagents.thinking` is set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Max concurrent: 8（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-archive: after 60 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setting a Default Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a cheaper model for sub-agents to save on token costs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "minimax/MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setting a Default Thinking Level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        thinking: "low",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Per-Agent Overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In a multi-agent setup, you can set sub-agent defaults per agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "researcher",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "anthropic/claude-sonnet-4",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "assistant",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "minimax/MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Concurrency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control how many sub-agents can run at the same time:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxConcurrent: 4, // default: 8（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agents use a dedicated queue lane (`subagent`) separate from the main agent queue, so sub-agent runs don't block inbound replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Auto-Archive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agent sessions are automatically archived after a configurable period:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        archiveAfterMinutes: 120, // default: 60（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Archive renames the transcript to `*.deleted.<timestamp>` (same folder) — transcripts are preserved, not deleted. Auto-archive timers are best-effort; pending timers are lost if the gateway restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The `sessions_spawn` Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the tool the agent calls to create sub-agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Parameter           | Type                   | Default            | Description                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | ---------------------- | ------------------ | -------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `task`              | string                 | _(required)_       | What the sub-agent should do                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `label`             | string                 | —                  | Short label for identification                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agentId`           | string                 | _(caller's agent)_ | Spawn under a different agent id (must be allowed)             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `model`             | string                 | _(optional)_       | Override the model for this sub-agent                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `thinking`          | string                 | _(optional)_       | Override thinking level (`off`, `low`, `medium`, `high`, etc.) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `runTimeoutSeconds` | number                 | `0` (no limit)     | Abort the sub-agent after N seconds                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `cleanup`           | `"delete"` \| `"keep"` | `"keep"`           | `"delete"` archives immediately after announce                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model Resolution Order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The sub-agent model is resolved in this order (first match wins):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Explicit `model` parameter in the `sessions_spawn` call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Per-agent config: `agents.list[].subagents.model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Global default: `agents.defaults.subagents.model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Target agent’s normal model resolution for that new session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thinking level is resolved in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Explicit `thinking` parameter in the `sessions_spawn` call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Per-agent config: `agents.list[].subagents.thinking`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Global default: `agents.defaults.subagents.thinking`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Otherwise no sub-agent-specific thinking override is applied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Invalid model values are silently skipped — the sub-agent runs on the next valid default with a warning in the tool result.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Cross-Agent Spawning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, sub-agents can only spawn under their own agent id. To allow an agent to spawn sub-agents under other agent ids:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "orchestrator",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowAgents: ["researcher", "coder"], // or ["*"] to allow any（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the `agents_list` tool to discover which agent ids are currently allowed for `sessions_spawn`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Managing Sub-Agents (`/subagents`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the `/subagents` slash command to inspect and control sub-agent runs for the current session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                                  | Description                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------------------- | ---------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/subagents list`                        | List all sub-agent runs (active and completed) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/subagents stop <id\|#\|all>`           | Stop a running sub-agent                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/subagents log <id\|#> [limit] [tools]` | View sub-agent transcript                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/subagents info <id\|#>`                | Show detailed run metadata                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/subagents send <id\|#> <message>`      | Send a message to a running sub-agent          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can reference sub-agents by list index (`1`, `2`), run id prefix, full session key, or `last`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Example: list and stop a sub-agent">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    /subagents list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    🧭 Subagents (current session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Active: 1 · Done: 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    1) ✅ · research logs · 2m31s · run a1b2c3d4 · agent:main:subagent:...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    2) ✅ · check deps · 45s · run e5f6g7h8 · agent:main:subagent:...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    3) 🔄 · deploy staging · 1m12s · run i9j0k1l2 · agent:main:subagent:...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    /subagents stop 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ⚙️ Stop requested for deploy staging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Example: inspect a sub-agent">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    /subagents info 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ℹ️ Subagent info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Status: ✅（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Label: research logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Task: Research the latest server error logs and summarize findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Run: a1b2c3d4-...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Session: agent:main:subagent:...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Runtime: 2m31s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Cleanup: keep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Outcome: ok（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Example: view sub-agent log">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    /subagents log 1 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Shows the last 10 messages from the sub-agent's transcript. Add `tools` to include tool call messages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    /subagents log 1 10 tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Example: send a follow-up message">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    /subagents send 3 "Also check the staging environment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Sends a message into the running sub-agent's session and waits up to 30 seconds for a reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Announce (How Results Come Back)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a sub-agent finishes, it goes through an **announce** step:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. The sub-agent's final reply is captured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. A summary message is sent to the main agent's session with the result, status, and stats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. The main agent posts a natural-language summary to your chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Announce replies preserve thread/topic routing when available (Slack threads, Telegram topics, Matrix threads).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Announce Stats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each announce includes a stats line with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime duration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token usage (input/output/total)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Estimated cost (when model pricing is configured via `models.providers.*.models[].cost`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session key, session id, and transcript path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Announce Status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The announce message includes a status derived from the runtime outcome (not from model output):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **successful completion** (`ok`) — task completed normally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **error** — task failed (error details in notes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **timeout** — task exceeded `runTimeoutSeconds`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **unknown** — status could not be determined（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no user-facing announcement is needed, the main-agent summarize step can return `NO_REPLY` and nothing is posted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is different from `ANNOUNCE_SKIP`, which is used in agent-to-agent announce flow (`sessions_send`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool Policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, sub-agents get **all tools except** a set of denied tools that are unsafe or unnecessary for background tasks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Default denied tools">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | Denied tool | Reason |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    |-------------|--------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `sessions_list` | Session management — main agent orchestrates |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `sessions_history` | Session management — main agent orchestrates |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `sessions_send` | Session management — main agent orchestrates |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `sessions_spawn` | No nested fan-out (sub-agents cannot spawn sub-agents) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `gateway` | System admin — dangerous from sub-agent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `agents_list` | System admin |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `whatsapp_login` | Interactive setup — not a task |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `session_status` | Status/scheduling — main agent coordinates |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `cron` | Status/scheduling — main agent coordinates |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `memory_search` | Pass relevant info in spawn prompt instead |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    | `memory_get` | Pass relevant info in spawn prompt instead |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Customizing Sub-Agent Tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can further restrict sub-agent tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // deny always wins over allow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deny: ["browser", "firecrawl"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To restrict sub-agents to **only** specific tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allow: ["read", "exec", "process", "write", "edit", "apply_patch"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // deny still wins if set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Custom deny entries are **added to** the default deny list. If `allow` is set, only those tools are available (the default deny list still applies on top).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authentication（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agent auth is resolved by **agent id**, not by session type:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The auth store is loaded from the target agent's `agentDir`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The main agent's auth profiles are merged in as a **fallback** (agent profiles win on conflicts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The merge is additive — main profiles are always available as fallbacks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fully isolated auth per sub-agent is not currently supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context and System Prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agents receive a reduced system prompt compared to the main agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Included:** Tooling, Workspace, Runtime sections, plus `AGENTS.md` and `TOOLS.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Not included:** `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The sub-agent also receives a task-focused system prompt that instructs it to stay focused on the assigned task, complete it, and not act as the main agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Stopping Sub-Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Method                 | Effect                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/stop` in the chat    | Aborts the main session **and** all active sub-agent runs spawned from it |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/subagents stop <id>` | Stops a specific sub-agent without affecting the main session             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `runTimeoutSeconds`    | Automatically aborts the sub-agent run after the specified time           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`runTimeoutSeconds` does **not** auto-archive the session. The session remains until the normal archive timer fires.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Full Configuration Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Accordion title="Complete sub-agent configuration">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "anthropic/claude-sonnet-4" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "minimax/MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        thinking: "low",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxConcurrent: 4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        archiveAfterMinutes: 30,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Personal Assistant",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "ops",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Ops Agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "anthropic/claude-sonnet-4",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowAgents: ["main"], // ops can spawn sub-agents under "main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deny: ["browser"], // sub-agents can't use the browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Warning>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Best-effort announce:** If the gateway restarts, pending announce work is lost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No nested spawning:** Sub-agents cannot spawn their own sub-agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Shared resources:** Sub-agents share the gateway process; use `maxConcurrent` as a safety valve.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Auto-archive is best-effort:** Pending archive timers are lost on gateway restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Warning>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Session Tools](/concepts/session-tool) — details on `sessions_spawn` and other session tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) — per-agent tool restrictions and sandboxing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Configuration](/gateway/configuration) — `agents.defaults.subagents` reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Queue](/concepts/queue) — how the `subagent` lane works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
