---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Routing rules per channel (WhatsApp, Telegram, Discord, Slack) and shared context"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing channel routing or inbox behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Channel Routing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Channels & routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw routes replies **back to the channel where a message came from**. The（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
model does not choose a channel; routing is deterministic and controlled by the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
host configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key terms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **AccountId**: per‑channel account instance (when supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **AgentId**: an isolated workspace + session store (“brain”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SessionKey**: the bucket key used to store context and control concurrency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session key shapes (examples)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Direct messages collapse to the agent’s **main** session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent:<agentId>:<mainKey>` (default: `agent:main:main`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Groups and channels remain isolated per channel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups: `agent:<agentId>:<channel>:group:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels/rooms: `agent:<agentId>:<channel>:channel:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Threads:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack/Discord threads append `:thread:<threadId>` to the base key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram forum topics embed `:topic:<topicId>` in the group key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent:main:telegram:group:-1001234567890:topic:42`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent:main:discord:channel:123456:thread:987654`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Routing rules (how an agent is chosen)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Routing picks **one agent** for each inbound message:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Exact peer match** (`bindings` with `peer.kind` + `peer.id`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Guild match** (Discord) via `guildId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Team match** (Slack) via `teamId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Account match** (`accountId` on the channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Channel match** (any account on that channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Default agent** (`agents.list[].default`, else first list entry, fallback to `main`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The matched agent determines which workspace and session store are used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Broadcast groups (run multiple agents)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Broadcast groups let you run **multiple agents** for the same peer **when OpenClaw would normally reply** (for example: in WhatsApp groups, after mention/activation gating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  broadcast: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    strategy: "parallel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363403215116621@g.us": ["alfred", "baerbel"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "+15555550123": ["support", "logger"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See: [Broadcast Groups](/channels/broadcast-groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list`: named agent definitions (workspace, model, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings`: map inbound channels/accounts/peers to agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session stores live under the state directory (default `~/.openclaw`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/agents/<agentId>/sessions/sessions.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSONL transcripts live alongside the store（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can override the store path via `session.store` and `{agentId}` templating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WebChat behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WebChat attaches to the **selected agent** and defaults to the agent’s main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session. Because of this, WebChat lets you see cross‑channel context for that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent in one place.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reply context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound replies include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ReplyToId`, `ReplyToBody`, and `ReplyToSender` when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quoted context is appended to `Body` as a `[Replying to ...]` block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is consistent across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
