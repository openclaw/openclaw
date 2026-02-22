---
summary: "Multi-agent လမ်းကြောင်းညွှန်ကြားမှု: သီးခြားခွဲထားသော agents၊ ချန်နယ်အကောင့်များ နှင့် bindings"
title: Multi-Agent Routing
read_when: "Gateway လုပ်ငန်းစဉ်တစ်ခုအတွင်း သီးခြားခွဲထားသော agents (workspace + auth) များကို များစွာ အသုံးပြုလိုသောအခါ။"
status: active
---

# Multi-Agent Routing

Goal: multiple _isolated_ agents (separate workspace + `agentDir` + sessions), plus multiple channel accounts (e.g. two WhatsApps) in one running Gateway. Inbound is routed to an agent via bindings.

## “agent တစ်ခု” ဆိုတာဘာလဲ?

**agent** ဆိုသည်မှာ ကိုယ်ပိုင် အတိုင်းအတာအပြည့်ရှိသော ဉာဏ်ရည် (brain) တစ်ခုဖြစ်ပြီး အောက်ပါအရာများကို ကိုယ်ပိုင်အဖြစ် ပိုင်ဆိုင်သည်–

- **Workspace** (ဖိုင်များ၊ AGENTS.md/SOUL.md/USER.md၊ local မှတ်စုများ၊ persona စည်းမျဉ်းများ)။
- **State directory** (`agentDir`) — auth profiles၊ model registry နှင့် agent တစ်ခုချင်းစီအလိုက် config များအတွက်။
- **Session store** (chat history + routing state) ကို `~/.openclaw/agents/<agentId>/sessions` အောက်တွင် သိမ်းဆည်းသည်။

Auth profiles are **per-agent**. Each agent reads from its own:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Main agent credentials are **not** shared automatically. Never reuse `agentDir`
across agents (it causes auth/session collisions). If you want to share creds,
copy `auth-profiles.json` into the other agent's `agentDir`.

Skills are per-agent via each workspace’s `skills/` folder, with shared skills
available from `~/.openclaw/skills`. See [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Gateway သည် **agent တစ်ခု** (default) သို့မဟုတ် **agent များစွာ** ကို အတူတကွ လက်တွဲအသုံးပြုနိုင်သည်။

**Workspace note:** each agent’s workspace is the **default cwd**, not a hard
sandbox. ၁။ Relative paths များသည် workspace အတွင်းမှာသာ resolve လုပ်ပေးပြီး absolute paths များကတော့ sandboxing မဖွင့်ထားပါက အခြား host location များကို ရောက်နိုင်ပါသည်။ ၂။ ကြည့်ရန်
[Sandboxing](/gateway/sandboxing)။

## Paths (အမြန်မြေပုံ)

- Config: `~/.openclaw/openclaw.json` (သို့မဟုတ် `OPENCLAW_CONFIG_PATH`)
- State dir: `~/.openclaw` (သို့မဟုတ် `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (သို့မဟုတ် `~/.openclaw/workspace-<agentId>`)
- Agent dir: `~/.openclaw/agents/<agentId>/agent` (သို့မဟုတ် `agents.list[].agentDir`)
- Sessions: `~/.openclaw/agents/<agentId>/sessions`

### Single-agent mode (default)

ဘာမှ မလုပ်ပါက OpenClaw သည် agent တစ်ခုတည်းဖြင့် လည်ပတ်သည်–

- `agentId` သည် **`main`** သို့ default သတ်မှတ်ထားသည်။
- Sessions များကို `agent:main:<mainKey>` အဖြစ် key ပြုလုပ်ထားသည်။
- Workspace သည် `~/.openclaw/workspace` (သို့မဟုတ် `OPENCLAW_PROFILE` ကို သတ်မှတ်ထားပါက `~/.openclaw/workspace-<profile>`) သို့ default ဖြစ်သည်။
- State သည် `~/.openclaw/agents/main/agent` သို့ default ဖြစ်သည်။

## Agent helper

Agent wizard ကို အသုံးပြု၍ သီးခြား agent အသစ်တစ်ခု ထည့်ပါ–

```bash
openclaw agents add work
```

ထို့နောက် အဝင်မက်ဆေ့ချ်များကို လမ်းကြောင်းညွှန်ကြားရန် `bindings` ကို ထည့်ပါ (သို့မဟုတ် wizard ကို အလိုအလျောက်လုပ်ဆောင်စေပါ)။

အတည်ပြုရန်–

```bash
openclaw agents list --bindings
```

## Agent များစွာ = လူများစွာ၊ ကိုယ်ရည်ကိုယ်သွေးများစွာ

**Agent များစွာ** အသုံးပြုသောအခါ `agentId` တစ်ခုချင်းစီသည် **သီးခြားခွဲထားသော persona** တစ်ခုဖြစ်လာသည်–

- **ဖုန်းနံပါတ်/အကောင့် မတူညီမှုများ** (ချန်နယ် `accountId` တစ်ခုချင်းစီအလိုက်)။
- **ကိုယ်ရည်ကိုယ်သွေး မတူညီမှုများ** (agent တစ်ခုချင်းစီ၏ workspace ဖိုင်များ כגון `AGENTS.md` နှင့် `SOUL.md`)။
- **Auth + sessions သီးခြားစီ** (အထူးခွင့်ပြုမထားပါက အပြန်အလှန် မထိခိုက်ပါ)။

ဤအရာက လူများစွာကို Gateway ဆာဗာတစ်ခုကို မျှဝေအသုံးပြုခွင့်ပေးပြီး AI “ဉာဏ်ရည်” နှင့် ဒေတာများကို သီးခြားထားရှိနိုင်စေသည်။

## WhatsApp နံပါတ်တစ်ခု၊ လူများစွာ (DM ခွဲခြားခြင်း)

၃။ **WhatsApp account တစ်ခုတည်း** ကို အသုံးပြုပြီး **မတူညီသော WhatsApp DMs များကို မတူညီသော agents များဆီသို့ route လုပ်နိုင်ပါသည်**။ sender E.164 (ဥပမာ `+15551234567`) အပေါ် `peer.kind: "direct"` ဖြင့် match လုပ်ပါ။ ၅။ Replies များသည် အတူတူသော WhatsApp နံပါတ်မှသာ ပြန်လာပါသည် (agent တစ်ခုချင်းစီအလိုက် sender identity မရှိပါ)။

အရေးကြီးသော အသေးစိတ်ချက်: direct chats များသည် agent ၏ **main session key** သို့ ပေါင်းစည်းသွားသဖြင့် စစ်မှန်သော သီးခြားခွဲခြားမှုအတွက် **လူတစ်ယောက်လျှင် agent တစ်ခု** လိုအပ်သည်။

ဥပမာ–

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

မှတ်ချက်များ–

- DM ဝင်ရောက်ခွင့်ထိန်းချုပ်မှုသည် **WhatsApp အကောင့်တစ်ခုလုံးအလိုက် global** ဖြစ်ပြီး agent အလိုက် မဟုတ်ပါ (pairing/allowlist)။
- Shared groups များအတွက် group ကို agent တစ်ခုသို့ bind လုပ်ပါ သို့မဟုတ် [Broadcast groups](/channels/broadcast-groups) ကို အသုံးပြုပါ။

## Routing rules (မက်ဆေ့ချ်များက agent ကို ဘယ်လိုရွေးချယ်သလဲ)

Bindings များသည် **ဆုံးဖြတ်နိုင်သော (deterministic)** ဖြစ်ပြီး **အထူးသတ်မှတ်ချက် အများဆုံးရှိသည့်အရာက အနိုင်ရ** သည်–

1. `peer` ကိုက်ညီမှု (DM/group/channel id အတိအကျ)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. ချန်နယ်တစ်ခုအတွက် `accountId` ကိုက်ညီမှု
5. ချန်နယ်အဆင့် ကိုက်ညီမှု (`accountId: "*"`)
6. default agent သို့ fallback (`agents.list[].default`၊ မရှိပါက စာရင်းထဲ ပထမဆုံး entry၊ default: `main`)

## အကောင့်များစွာ / ဖုန်းနံပါတ်များစွာ

၆။ **account များစွာကို support လုပ်သော** channels များ (ဥပမာ WhatsApp) သည် login တစ်ခုချင်းစီကို ခွဲခြားသတ်မှတ်ရန် `accountId` ကို အသုံးပြုပါသည်။ ၇။ `accountId` တစ်ခုချင်းစီကို မတူညီသော agent ဆီသို့ route လုပ်နိုင်သောကြောင့် server တစ်လုံးတည်းက session မရောနှောဘဲ ဖုန်းနံပါတ်များစွာကို host လုပ်နိုင်ပါသည်။

## Concepts

- `agentId`: “ဉာဏ်ရည်” တစ်ခု (workspace၊ per-agent auth၊ per-agent session store)။
- `accountId`: ချန်နယ်အကောင့် instance တစ်ခု (ဥပမာ WhatsApp အကောင့် `"personal"` နှင့် `"biz"`)။
- `binding`: inbound မက်ဆေ့ချ်များကို `agentId` သို့ `(channel, accountId, peer)` နှင့် လိုအပ်ပါက guild/team ids များဖြင့် လမ်းကြောင်းညွှန်ကြားပေးသည်။
- Direct chats များသည် `agent:<agentId>:<mainKey>` (agent တစ်ခုချင်းစီ၏ “main”; `session.mainKey`) သို့ ပေါင်းစည်းသွားသည်။

## ဥပမာ: WhatsApp နှစ်ခု → agent နှစ်ခု

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

## ဥပမာ: WhatsApp နေ့စဉ်ချတ် + Telegram အာရုံစိုက်လုပ်ဆောင်မှု

ချန်နယ်အလိုက် ခွဲခြားခြင်း: WhatsApp ကို အမြန် နေ့စဉ် agent သို့၊ Telegram ကို Opus agent သို့ လမ်းကြောင်းညွှန်ကြားပါ။

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

မှတ်ချက်များ–

- ချန်နယ်တစ်ခုအတွက် အကောင့်များစွာရှိပါက binding ထဲတွင် `accountId` ကို ထည့်ပါ (ဥပမာ `{ channel: "whatsapp", accountId: "personal" }`)။
- DM/group တစ်ခုတည်းကို Opus သို့ လမ်းကြောင်းညွှန်ကြားလိုပြီး အခြားအားလုံးကို chat အပေါ်ထားလိုပါက ထို peer အတွက် `match.peer` binding ကို ထည့်ပါ; peer ကိုက်ညီမှုများသည် အမြဲ channel-wide rules များထက် အနိုင်ရသည်။

## ဥပမာ: ချန်နယ်တစ်ခုတည်း၊ peer တစ်ခုကို Opus သို့

WhatsApp ကို အမြန် agent ပေါ်တွင်ထားပြီး DM တစ်ခုကို Opus သို့ လမ်းကြောင်းညွှန်ကြားပါ–

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
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Peer bindings များသည် အမြဲ အနိုင်ရသောကြောင့် channel-wide rule အပေါ်တွင် ထားပါ။

## WhatsApp group တစ်ခုနှင့် ချိတ်ဆက်ထားသော Family agent

မိသားစုအတွက် သီးသန့် agent တစ်ခုကို WhatsApp group တစ်ခုတည်းနှင့် bind လုပ်ပြီး mention gating နှင့် ပိုမိုတင်းကျပ်သော tool မူဝါဒကို အသုံးပြုပါ–

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

မှတ်ချက်များ–

- ၈။ Tool allow/deny lists များသည် skills မဟုတ်ဘဲ **tools** ဖြစ်ပါသည်။ ၉။ Skill တစ်ခုက binary ကို run လုပ်ရန်လိုအပ်ပါက `exec` ကို allow လုပ်ထားပြီး binary သည် sandbox အတွင်းရှိနေကြောင်း သေချာပါစေ။
- ပိုမိုတင်းကျပ်သော gating အတွက် `agents.list[].groupChat.mentionPatterns` ကို သတ်မှတ်ပြီး ချန်နယ်အတွက် group allowlists များကို ဖွင့်ထားပါ။

## Per-Agent Sandbox နှင့် Tool Configuration

v2026.1.6 မှစ၍ agent တစ်ခုချင်းစီတွင် ကိုယ်ပိုင် sandbox နှင့် tool ကန့်သတ်ချက်များ ရှိနိုင်ပါသည်–

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

၁၀။ မှတ်ချက်: `setupCommand` သည် `sandbox.docker` အောက်တွင်ရှိပြီး container ဖန်တီးချိန်တွင် တစ်ကြိမ်သာ run လုပ်ပါသည်။
၁၁။ resolved scope သည် `"shared"` ဖြစ်သောအခါ per-agent `sandbox.docker.*` overrides များကို ignore လုပ်ပါသည်။

**အကျိုးကျေးဇူးများ:**

- **လုံခြုံရေး သီးခြားခွဲခြားမှု**: ယုံကြည်မရသော agents များအတွက် tools များကို ကန့်သတ်နိုင်သည်
- **အရင်းအမြစ် ထိန်းချုပ်မှု**: agent တချို့ကို sandbox အတွင်းထားပြီး အခြားများကို host ပေါ်တွင် ထားနိုင်သည်
- **မူဝါဒ လိုက်လျောညီထွေမှု**: agent တစ်ခုချင်းစီအလိုက် ခွင့်ပြုချက် မတူညီနိုင်သည်

၁၂။ မှတ်ချက်: `tools.elevated` သည် **global** ဖြစ်ပြီး sender-based ဖြစ်ပါသည်။ agent တစ်ခုချင်းစီအလိုက် configure လုပ်၍ မရပါ။
၁၃။ Per-agent boundaries လိုအပ်ပါက `agents.list[].tools` ကို အသုံးပြုပြီး `exec` ကို deny လုပ်ပါ။
၁၄။ Group targeting အတွက် `agents.list[].groupChat.mentionPatterns` ကို အသုံးပြုပါ၊ ထို့ကြောင့် @mentions များသည် ရည်ရွယ်ထားသော agent ဆီသို့ သန့်ရှင်းစွာ map လုပ်နိုင်ပါသည်။

အသေးစိတ် ဥပမာများအတွက် [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) ကိုကြည့်ပါ။
