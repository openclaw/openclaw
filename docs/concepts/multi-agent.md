---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Multi-agent routing: isolated agents, channel accounts, and bindings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Multi-Agent Routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "You want multiple isolated agents (workspaces + auth) in one gateway process."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: active（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Multi-Agent Routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: multiple _isolated_ agents (separate workspace + `agentDir` + sessions), plus multiple channel accounts (e.g. two WhatsApps) in one running Gateway. Inbound is routed to an agent via bindings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What is “one agent”?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An **agent** is a fully scoped brain with its own:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace** (files, AGENTS.md/SOUL.md/USER.md, local notes, persona rules).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **State directory** (`agentDir`) for auth profiles, model registry, and per-agent config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session store** (chat history + routing state) under `~/.openclaw/agents/<agentId>/sessions`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth profiles are **per-agent**. Each agent reads from its own:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/agents/<agentId>/agent/auth-profiles.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Main agent credentials are **not** shared automatically. Never reuse `agentDir`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
across agents (it causes auth/session collisions). If you want to share creds,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
copy `auth-profiles.json` into the other agent's `agentDir`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills are per-agent via each workspace’s `skills/` folder, with shared skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
available from `~/.openclaw/skills`. See [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway can host **one agent** (default) or **many agents** side-by-side.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Workspace note:** each agent’s workspace is the **default cwd**, not a hard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sandbox. Relative paths resolve inside the workspace, but absolute paths can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
reach other host locations unless sandboxing is enabled. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Sandboxing](/gateway/sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Paths (quick map)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State dir: `~/.openclaw` (or `OPENCLAW_STATE_DIR`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace: `~/.openclaw/workspace` (or `~/.openclaw/workspace-<agentId>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent dir: `~/.openclaw/agents/<agentId>/agent` (or `agents.list[].agentDir`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: `~/.openclaw/agents/<agentId>/sessions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Single-agent mode (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you do nothing, OpenClaw runs a single agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agentId` defaults to **`main`**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions are keyed as `agent:main:<mainKey>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace defaults to `~/.openclaw/workspace` (or `~/.openclaw/workspace-<profile>` when `OPENCLAW_PROFILE` is set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State defaults to `~/.openclaw/agents/main/agent`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent helper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the agent wizard to add a new isolated agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents add work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then add `bindings` (or let the wizard do it) to route inbound messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents list --bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multiple agents = multiple people, multiple personalities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With **multiple agents**, each `agentId` becomes a **fully isolated persona**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Different phone numbers/accounts** (per channel `accountId`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Different personalities** (per-agent workspace files like `AGENTS.md` and `SOUL.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Separate auth + sessions** (no cross-talk unless explicitly enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This lets **multiple people** share one Gateway server while keeping their AI “brains” and data isolated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## One WhatsApp number, multiple people (DM split)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can route **different WhatsApp DMs** to different agents while staying on **one WhatsApp account**. Match on sender E.164 (like `+15551234567`) with `peer.kind: "direct"`. Replies still come from the same WhatsApp number (no per‑agent sender identity).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Important detail: direct chats collapse to the agent’s **main session key**, so true isolation requires **one agent per person**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "alex",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "mia",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15551230001", "+15551230002"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM access control is **global per WhatsApp account** (pairing/allowlist), not per agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For shared groups, bind the group to one agent or use [Broadcast groups](/channels/broadcast-groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Routing rules (how messages pick an agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bindings are **deterministic** and **most-specific wins**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `peer` match (exact DM/group/channel id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `guildId` (Discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `teamId` (Slack)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `accountId` match for a channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. channel-level match (`accountId: "*"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. fallback to default agent (`agents.list[].default`, else first list entry, default: `main`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multiple accounts / phone numbers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channels that support **multiple accounts** (e.g. WhatsApp) use `accountId` to identify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
each login. Each `accountId` can be routed to a different agent, so one server can host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
multiple phone numbers without mixing sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Concepts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agentId`: one “brain” (workspace, per-agent auth, per-agent session store).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accountId`: one channel account instance (e.g. WhatsApp account `"personal"` vs `"biz"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `binding`: routes inbound messages to an `agentId` by `(channel, accountId, peer)` and optionally guild/team ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct chats collapse to `agent:<agentId>:<mainKey>` (per-agent “main”; `session.mainKey`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example: two WhatsApps → two agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/openclaw.json` (JSON5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```js（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "home",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Home",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-home",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        agentDir: "~/.openclaw/agents/home/agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        agentDir: "~/.openclaw/agents/work/agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Deterministic routing: first match wins (most-specific first).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Optional per-peer override (example: send a specific group to work agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "whatsapp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId: "personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        peer: { kind: "group", id: "1203630...@g.us" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agentToAgent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allow: ["home", "work"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        personal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // authDir: "~/.openclaw/credentials/whatsapp/personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        biz: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // authDir: "~/.openclaw/credentials/whatsapp/biz",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example: WhatsApp daily chat + Telegram deep work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Split by channel: route WhatsApp to a fast everyday agent and Telegram to an Opus agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "chat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Everyday",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-chat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "anthropic/claude-sonnet-4-5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Deep Work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "chat", match: { channel: "whatsapp" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "opus", match: { channel: "telegram" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you have multiple accounts for a channel, add `accountId` to the binding (for example `{ channel: "whatsapp", accountId: "personal" }`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To route a single DM/group to Opus while keeping the rest on chat, add a `match.peer` binding for that peer; peer matches always win over channel-wide rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example: same channel, one peer to Opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep WhatsApp on the fast agent, but route one DM to Opus:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "chat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Everyday",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-chat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "anthropic/claude-sonnet-4-5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Deep Work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "chat", match: { channel: "whatsapp" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Peer bindings always win, so keep them above the channel-wide rule.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Family agent bound to a WhatsApp group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bind a dedicated family agent to a single WhatsApp group, with mention gating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and a tighter tool policy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        identity: { name: "Family Bot" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mode: "all",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          scope: "agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "exec",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_spawn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "session_status",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      agentId: "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      match: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "whatsapp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        peer: { kind: "group", id: "120363999999999999@g.us" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool allow/deny lists are **tools**, not skills. If a skill needs to run a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  binary, ensure `exec` is allowed and the binary exists in the sandbox.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For stricter gating, set `agents.list[].groupChat.mentionPatterns` and keep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  group allowlists enabled for the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Per-Agent Sandbox and Tool Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Starting with v2026.1.6, each agent can have its own sandbox and tool restrictions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```js（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mode: "off",  // No sandbox for personal agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // No tool restrictions - all tools available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mode: "all",     // Always sandboxed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          scope: "agent",  // One container per agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          docker: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            // Optional one-time setup after container creation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            setupCommand: "apt-get update && apt-get install -y git curl",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: ["read"],                    // Only read tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: `setupCommand` lives under `sandbox.docker` and runs once on container creation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent `sandbox.docker.*` overrides are ignored when the resolved scope is `"shared"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Benefits:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Security isolation**: Restrict tools for untrusted agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Resource control**: Sandbox specific agents while keeping others on host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Flexible policies**: Different permissions per agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: `tools.elevated` is **global** and sender-based; it is not configurable per agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need per-agent boundaries, use `agents.list[].tools` to deny `exec`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For group targeting, use `agents.list[].groupChat.mentionPatterns` so @mentions map cleanly to the intended agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for detailed examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
