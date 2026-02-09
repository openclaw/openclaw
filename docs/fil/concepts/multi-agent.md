---
summary: "Multi-agent routing: mga hiwalay na agent, mga channel account, at mga binding"
title: Multi-Agent Routing
read_when: "Gusto mo ng maraming hiwalay na agent (workspaces + auth) sa iisang Gateway process."
status: active
---

# Multi-Agent Routing

Goal: multiple _isolated_ agents (separate workspace + `agentDir` + sessions), plus multiple channel accounts (e.g. two WhatsApps) in one running Gateway. Inbound is routed to an agent via bindings.

## Ano ang “isang agent”?

Ang isang **agent** ay isang ganap na nakapaloob na “utak” na may sariling:

- **Workspace** (mga file, AGENTS.md/SOUL.md/USER.md, lokal na mga tala, mga patakaran ng persona).
- **State directory** (`agentDir`) para sa mga auth profile, model registry, at per-agent na config.
- **Session store** (kasaysayan ng chat + routing state) sa ilalim ng `~/.openclaw/agents/<agentId>/sessions`.

Auth profiles are **per-agent**. Each agent reads from its own:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Main agent credentials are **not** shared automatically. Never reuse `agentDir`
across agents (it causes auth/session collisions). If you want to share creds,
copy `auth-profiles.json` into the other agent's `agentDir`.

Skills are per-agent via each workspace’s `skills/` folder, with shared skills
available from `~/.openclaw/skills`. See [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Maaaring mag-host ang Gateway ng **isang agent** (default) o **maraming agent** nang magkakatabi.

**Workspace note:** each agent’s workspace is the **default cwd**, not a hard
sandbox. Relative paths resolve inside the workspace, but absolute paths can
reach other host locations unless sandboxing is enabled. See
[Sandboxing](/gateway/sandboxing).

## Mga path (mabilis na mapa)

- Config: `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`)
- State dir: `~/.openclaw` (o `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (o `~/.openclaw/workspace-<agentId>`)
- Agent dir: `~/.openclaw/agents/<agentId>/agent` (o `agents.list[].agentDir`)
- Sessions: `~/.openclaw/agents/<agentId>/sessions`

### Single-agent mode (default)

Kung wala kang gagawin, tatakbo ang OpenClaw bilang isang agent:

- Ang `agentId` ay default sa **`main`**.
- Ang mga session ay naka-key bilang `agent:main:<mainKey>`.
- Ang workspace ay default sa `~/.openclaw/workspace` (o `~/.openclaw/workspace-<profile>` kapag naka-set ang `OPENCLAW_PROFILE`).
- Ang state ay default sa `~/.openclaw/agents/main/agent`.

## Agent helper

Gamitin ang agent wizard para magdagdag ng bagong hiwalay na agent:

```bash
openclaw agents add work
```

Pagkatapos ay idagdag ang `bindings` (o hayaan ang wizard ang gumawa nito) para i-route ang inbound na mga mensahe.

I-verify gamit ang:

```bash
openclaw agents list --bindings
```

## Maramihang agent = maraming tao, maraming personalidad

Kapag **maraming agent**, ang bawat `agentId` ay nagiging isang **ganap na hiwalay na persona**:

- **Magkakaibang numero ng telepono/account** (per-channel `accountId`).
- **Magkakaibang personalidad** (per-agent na mga file sa workspace tulad ng `AGENTS.md` at `SOUL.md`).
- **Magkahiwalay na auth + session** (walang cross-talk maliban kung hayagang pinahintulutan).

Pinapahintulutan nito ang **maraming tao** na magbahagi ng isang Gateway server habang pinananatiling hiwalay ang kanilang AI “utak” at data.

## Isang WhatsApp number, maraming tao (DM split)

You can route **different WhatsApp DMs** to different agents while staying on **one WhatsApp account**. Match on sender E.164 (like `+15551234567`) with `peer.kind: "dm"`. Replies still come from the same WhatsApp number (no per‑agent sender identity).

Mahalagang detalye: ang mga direct chat ay nagsasama sa **pangunahing session key** ng agent, kaya ang tunay na isolation ay nangangailangan ng **isang agent bawat tao**.

Halimbawa:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Mga tala:

- Ang DM access control ay **global per WhatsApp account** (pairing/allowlist), hindi per agent.
- Para sa mga shared group, i-bind ang grupo sa isang agent o gamitin ang [Broadcast groups](/channels/broadcast-groups).

## Mga routing rule (kung paano pumipili ng agent ang mga mensahe)

Ang mga binding ay **deterministic** at **ang pinaka-tiyak ang nananalo**:

1. `peer` na tugma (eksaktong DM/group/channel id)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. `accountId` na tugma para sa isang channel
5. channel-level na tugma (`accountId: "*"`)
6. fallback sa default agent (`agents.list[].default`, kung hindi ay ang unang entry sa listahan, default: `main`)

## Maramihang account / numero ng telepono

Channels that support **multiple accounts** (e.g. WhatsApp) use `accountId` to identify
each login. Each `accountId` can be routed to a different agent, so one server can host
multiple phone numbers without mixing sessions.

## Mga konsepto

- `agentId`: isang “utak” (workspace, per-agent na auth, per-agent na session store).
- `accountId`: isang channel account instance (hal. WhatsApp account `"personal"` kumpara sa `"biz"`).
- `binding`: niruruta ang inbound na mga mensahe papunta sa isang `agentId` batay sa `(channel, accountId, peer)` at opsyonal na mga guild/team id.
- Ang mga direct chat ay nagsasama sa `agent:<agentId>:<mainKey>` (per-agent na “main”; `session.mainKey`).

## Halimbawa: dalawang WhatsApp → dalawang agent

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Halimbawa: WhatsApp araw-araw na chat + Telegram deep work

Hatiin ayon sa channel: i-route ang WhatsApp sa isang mabilis na pang-araw-araw na agent at ang Telegram sa isang Opus agent.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Mga tala:

- Kung mayroon kang maraming account para sa isang channel, idagdag ang `accountId` sa binding (halimbawa `{ channel: "whatsapp", accountId: "personal" }`).
- Para i-route ang isang DM/group sa Opus habang pinananatili ang iba sa chat, magdagdag ng `match.peer` na binding para sa peer na iyon; laging nananalo ang mga peer match laban sa mga channel-wide rule.

## Halimbawa: parehong channel, isang peer papunta sa Opus

Panatilihin ang WhatsApp sa mabilis na agent, ngunit i-route ang isang DM sa Opus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Laging nananalo ang mga peer binding, kaya panatilihin ang mga ito sa itaas ng channel-wide rule.

## Family agent na naka-bind sa isang WhatsApp group

I-bind ang isang dedikadong family agent sa isang WhatsApp group, na may mention gating
at mas mahigpit na tool policy:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Mga tala:

- Tool allow/deny lists are **tools**, not skills. If a skill needs to run a
  binary, ensure `exec` is allowed and the binary exists in the sandbox.
- Para sa mas mahigpit na gating, itakda ang `agents.list[].groupChat.mentionPatterns` at panatilihing
  naka-enable ang mga group allowlist para sa channel.

## Per-Agent Sandbox at Tool Configuration

Simula sa v2026.1.6, ang bawat agent ay maaaring magkaroon ng sariling sandbox at mga restriksyon sa tool:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

Note: `setupCommand` lives under `sandbox.docker` and runs once on container creation.
Per-agent `sandbox.docker.*` overrides are ignored when the resolved scope is `"shared"`.

**Mga benepisyo:**

- **Security isolation**: Limitahan ang mga tool para sa mga hindi pinagkakatiwalaang agent
- **Resource control**: I-sandbox ang mga partikular na agent habang pinananatili ang iba sa host
- **Flexible na mga polisiya**: Iba’t ibang pahintulot kada agent

Note: `tools.elevated` is **global** and sender-based; it is not configurable per agent.
If you need per-agent boundaries, use `agents.list[].tools` to deny `exec`.
For group targeting, use `agents.list[].groupChat.mentionPatterns` so @mentions map cleanly to the intended agent.

Tingnan ang [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para sa detalyadong mga halimbawa.
