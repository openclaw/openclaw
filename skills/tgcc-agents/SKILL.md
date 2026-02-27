---
name: tgcc-agents
description: 'Interact with TGCC-managed agents (sentinella, kyobot, saemem) via the supervisor protocol. Use when: routing tasks to persistent Telegram bots managed by TGCC, checking TGCC agent status, or coordinating across TGCC-managed CC sessions. NOT for: spawning new CC sessions (use coding-agent skill), direct Telegram bot interaction, or tasks that don't involve TGCC agents.'
metadata:
  { "openclaw": { "emoji": "🔌" } }
---

# TGCC Agents — Supervisor Protocol Integration

Talk to **persistent TGCC agents** (sentinella, kyobot, saemem, etc.) directly from OpenClaw via the supervisor protocol. Messages route through a Unix socket to TGCC, which manages the actual Claude Code processes.

## Key Concepts

### TGCC vs Direct CC Spawn

| | TGCC Agents | Direct CC Spawn |
|---|---|---|
| **What** | Persistent bots with Telegram integration | Ephemeral CC sessions |
| **How** | `sessions_send` → supervisor protocol → TGCC | `sessions_spawn` or coding-agent skill |
| **Agents** | sentinella, kyobot, saemem (auto-discovered) | Created on demand |
| **Shared** | Fnz can also talk to them via Telegram | Only OpenClaw sees them |
| **Lifecycle** | TGCC manages process start/stop | OpenClaw manages lifecycle |

### Auto-Discovery

TGCC agents are **auto-discovered** — no static config needed beyond the socket path:

```yaml
# openclaw.json — only config needed
agents:
  defaults:
    subagents:
      claudeCode:
        tgccSupervisor:
          socket: /tmp/tgcc/ctl/tgcc.sock
```

On connect, OpenClaw queries TGCC for available agents and caches them (60s TTL). The `agents_list` tool shows them automatically.

## Sending Messages to TGCC Agents

Use `sessions_send` with the agent name as the label:

```
sessions_send(label="sentinella", message="Check tile coverage for Ibiza")
```

This routes through the supervisor protocol:
1. OpenClaw detects "sentinella" is a known TGCC agent
2. Sends `send_message` command via Unix socket to TGCC
3. TGCC spawns or resumes a CC process for that agent
4. CC works on the task
5. When done, TGCC sends a `result` event back
6. OpenClaw's announce flow delivers the result to the requester

**Important:** The CC process is shared. If Fnz is also talking to sentinella via Telegram, both see the same session. OpenClaw auto-subscribes to events.

## Monitoring & Control

### List active agents

```
subagents list
```

TGCC-backed runs show with a `[tgcc]` prefix. Untracked TGCC agents with active CC processes also appear at the bottom.

### Steer an active TGCC agent

```
subagents steer target="sentinella" message="Also compare with last month's data"
```

Routes `send_to_cc` through the supervisor — writes directly to the running CC process's stdin. Does NOT spawn a new process.

### Kill a TGCC agent's CC process

```
subagents kill target="sentinella"
```

Routes `kill_cc` through the supervisor.

## Status

`session_status` shows TGCC connection state:

```
🔌 TGCC: connected (3 agents)
```

Or when disconnected:
```
🔌 TGCC: reconnecting
```

## How It Works Under the Hood

```
OpenClaw                    TGCC Bridge                CC Process
  │                            │                          │
  │─── send_message ──────────►│                          │
  │    {agentId, text}         │─── spawn/resume CC ─────►│
  │◄── response ──────────────│    {sessionId, state}     │
  │                            │                          │
  │    (CC works...)           │                          │
  │                            │◄── result ───────────────│
  │◄── event: result ─────────│    {text, cost}           │
  │                            │                          │
  │─── announce to requester   │                          │
```

- **Protocol:** NDJSON over Unix socket (`/tmp/tgcc/ctl/tgcc.sock`)
- **Registration:** OpenClaw registers as `openclaw` supervisor on connect
- **Heartbeat:** Ping/pong every 30s, reconnect with exponential backoff on failure
- **Auto-start:** If configured, attempts `systemctl --user start tgcc.service` on first connection failure

## Subagent Registry Integration

TGCC runs are tracked in the subagent registry with:
- `childSessionKey`: `tgcc:{agentId}` (e.g., `tgcc:sentinella`)
- `transport`: `"tgcc-supervisor"`
- `tgccAgentId`: the TGCC agent name

One active run per agent — TGCC manages sessions internally.

## When NOT to Use This

- **New coding tasks in a repo:** Use the coding-agent skill to spawn a fresh CC session
- **Tasks that need isolation:** TGCC agents share sessions with Telegram users
- **Quick one-off edits:** Use the `edit` tool directly
