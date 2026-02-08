---
summary: "Multi-agent routing: mga hiwalay na agent, mga channel account, at mga binding"
title: Multi-Agent Routing
read_when: "Gusto mo ng maraming hiwalay na agent (workspaces + auth) sa iisang Gateway process."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:33Z
---

# Multi-Agent Routing

Layunin: maraming _hiwalay_ na agent (magkakahiwalay na workspace + `agentDir` + mga session), kasama ang maraming channel account (hal. dalawang WhatsApp) sa isang tumatakbong Gateway. Ang inbound ay niruruta papunta sa isang agent sa pamamagitan ng mga binding.

## Ano ang “isang agent”?

Ang isang **agent** ay isang ganap na nakapaloob na “utak” na may sariling:

- **Workspace** (mga file, AGENTS.md/SOUL.md/USER.md, lokal na mga tala, mga patakaran ng persona).
- **State directory** (`agentDir`) para sa mga auth profile, model registry, at per-agent na config.
- **Session store** (kasaysayan ng chat + routing state) sa ilalim ng `~/.openclaw/agents/<agentId>/sessions`.

Ang mga auth profile ay **per-agent**. Ang bawat agent ay nagbabasa mula sa sarili nitong:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Ang pangunahing kredensyal ng agent ay **hindi** awtomatikong ibinabahagi. Huwag kailanman muling gamitin ang `agentDir`
sa iba’t ibang agent (nagiging sanhi ito ng banggaan ng auth/session). Kung gusto mong magbahagi ng creds,
kopyahin ang `auth-profiles.json` papunta sa `agentDir` ng ibang agent.

Ang Skills ay per-agent sa pamamagitan ng `skills/` folder ng bawat workspace, na may mga shared skill
na available mula sa `~/.openclaw/skills`. Tingnan ang [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Maaaring mag-host ang Gateway ng **isang agent** (default) o **maraming agent** nang magkakatabi.

**Tala sa workspace:** ang workspace ng bawat agent ang **default cwd**, hindi isang hard
sandbox. Ang mga relative path ay nagre-resolve sa loob ng workspace, ngunit ang mga absolute path ay maaaring
umabot sa ibang lokasyon ng host maliban kung naka-enable ang sandboxing. Tingnan ang
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

Maaari mong i-route ang **iba’t ibang WhatsApp DM** papunta sa iba’t ibang agent habang nananatili sa **isang WhatsApp account**. Mag-match batay sa sender E.164 (tulad ng `+15551234567`) gamit ang `peer.kind: "dm"`. Ang mga sagot ay manggagaling pa rin sa parehong WhatsApp number (walang per-agent na sender identity).

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

Ang mga channel na sumusuporta sa **maramihang account** (hal. WhatsApp) ay gumagamit ng `accountId` para tukuyin
ang bawat login. Ang bawat `accountId` ay maaaring i-route sa ibang agent, kaya ang isang server ay maaaring mag-host ng
maraming numero ng telepono nang hindi naghahalo ng mga session.

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

- Ang mga allow/deny list ng tool ay **tools**, hindi skills. Kung ang isang skill ay kailangang magpatakbo ng
  binary, tiyaking pinapayagan ang `exec` at umiiral ang binary sa sandbox.
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

Tala: ang `setupCommand` ay nasa ilalim ng `sandbox.docker` at tumatakbo nang isang beses sa paglikha ng container.
Ang mga per-agent na override ng `sandbox.docker.*` ay binabalewala kapag ang resolved scope ay `"shared"`.

**Mga benepisyo:**

- **Security isolation**: Limitahan ang mga tool para sa mga hindi pinagkakatiwalaang agent
- **Resource control**: I-sandbox ang mga partikular na agent habang pinananatili ang iba sa host
- **Flexible na mga polisiya**: Iba’t ibang pahintulot kada agent

Tala: ang `tools.elevated` ay **global** at batay sa sender; hindi ito nako-configure per agent.
Kung kailangan mo ng per-agent na hangganan, gamitin ang `agents.list[].tools` para i-deny ang `exec`.
Para sa group targeting, gamitin ang `agents.list[].groupChat.mentionPatterns` upang ang mga @mention ay malinaw na ma-map sa nilalayong agent.

Tingnan ang [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para sa detalyadong mga halimbawa.
