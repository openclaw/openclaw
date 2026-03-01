---
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: "agent"
---

# `openclaw agent`

Run a single agent turn via the Gateway. Use `--local` to run the embedded agent directly (requires model provider API keys in your shell environment).

Use `--agent <id>` to target a specific configured agent, or `--to` to route by recipient number.

Related:

- Agent send tool: [Agent send](/tools/agent-send)
- Managing agents: [`openclaw agents`](/cli/agents)

## Flags

| Flag | Description |
|------|-------------|
| `-m, --message <text>` | **(Required)** Message body for the agent |
| `-t, --to <number>` | Recipient number in E.164 format, used to derive the session key |
| `--session-id <id>` | Target an explicit session id instead of routing by recipient |
| `--agent <id>` | Agent id to use (overrides routing bindings) |
| `--thinking <level>` | Thinking level: `off` \| `minimal` \| `low` \| `medium` \| `high` |
| `--verbose <on\|off>` | Persist agent verbose level for the session |
| `--channel <channel>` | Delivery channel (omit to use the main session channel) |
| `--reply-to <target>` | Delivery target override (separate from session routing) |
| `--reply-channel <channel>` | Delivery channel override (separate from routing) |
| `--reply-account <id>` | Delivery account id override |
| `--deliver` | Send the agent's reply back to the selected channel |
| `--local` | Run the embedded agent locally instead of via Gateway |
| `--json` | Output result as JSON |
| `--timeout <seconds>` | Agent command timeout (default: `600` or config value) |

## Examples

Start a new session by recipient number:

```bash
openclaw agent --to +15555550123 --message "status update"
```

Target a specific agent:

```bash
openclaw agent --agent ops --message "Summarize logs"
```

Target an existing session with extended thinking:

```bash
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
```

Enable verbose logging and get JSON output:

```bash
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
```

Deliver the reply back to the session channel:

```bash
openclaw agent --to +15555550123 --message "Summon reply" --deliver
```

Deliver the reply to a different channel and target:

```bash
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

Run with the local embedded agent (no Gateway required):

```bash
openclaw agent --local --message "Hello"
```
