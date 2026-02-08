---
summary: "Multi-agent လမ်းကြောင်းညွှန်ကြားမှု: သီးခြားခွဲထားသော agents၊ ချန်နယ်အကောင့်များ နှင့် bindings"
title: Multi-Agent Routing
read_when: "Gateway လုပ်ငန်းစဉ်တစ်ခုအတွင်း သီးခြားခွဲထားသော agents (workspace + auth) များကို များစွာ အသုံးပြုလိုသောအခါ။"
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:43Z
---

# Multi-Agent Routing

ရည်မှန်းချက်: လည်ပတ်နေသော Gateway တစ်ခုအတွင်း _သီးခြားခွဲထားသော_ agents များ (သီးသန့် workspace + `agentDir` + sessions) ကို များစွာ အသုံးပြုနိုင်စေရန်၊ ထို့အပြင် ချန်နယ်အကောင့်များ (ဥပမာ WhatsApp နှစ်ခု) ကိုလည်း များစွာ အသုံးပြုနိုင်ရန်။ အဝင်မက်ဆေ့ချ်များကို bindings များဖြင့် agent သို့ လမ်းကြောင်းညွှန်ကြားသည်။

## “agent တစ်ခု” ဆိုတာဘာလဲ?

**agent** ဆိုသည်မှာ ကိုယ်ပိုင် အတိုင်းအတာအပြည့်ရှိသော ဉာဏ်ရည် (brain) တစ်ခုဖြစ်ပြီး အောက်ပါအရာများကို ကိုယ်ပိုင်အဖြစ် ပိုင်ဆိုင်သည်–

- **Workspace** (ဖိုင်များ၊ AGENTS.md/SOUL.md/USER.md၊ local မှတ်စုများ၊ persona စည်းမျဉ်းများ)။
- **State directory** (`agentDir`) — auth profiles၊ model registry နှင့် agent တစ်ခုချင်းစီအလိုက် config များအတွက်။
- **Session store** (chat history + routing state) ကို `~/.openclaw/agents/<agentId>/sessions` အောက်တွင် သိမ်းဆည်းသည်။

Auth profiles များသည် **agent တစ်ခုချင်းစီအလိုက်** ဖြစ်သည်။ Agent တစ်ခုစီသည် ကိုယ်ပိုင်အနေဖြင့် အောက်ပါနေရာမှ ဖတ်ရှုသည်–

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

အဓိက agent ၏ credentials များကို အလိုအလျောက် မမျှဝေပါ။ `agentDir` ကို agents များအကြား မည်သည့်အခါမှ ပြန်လည်အသုံးမပြုပါနှင့် (auth/session များ ထိခိုက်မှု ဖြစ်စေသည်)။ credentials မျှဝေလိုပါက `auth-profiles.json` ကို အခြား agent ၏ `agentDir` ထဲသို့ ကူးယူပါ။

Skills များသည် workspace တစ်ခုချင်းစီ၏ `skills/` ဖိုလ်ဒါမှတဆင့် **agent တစ်ခုချင်းစီအလိုက်** ဖြစ်ပြီး၊ `~/.openclaw/skills` မှ shared skills များကို အသုံးပြုနိုင်သည်။ [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills) ကိုကြည့်ပါ။

Gateway သည် **agent တစ်ခု** (default) သို့မဟုတ် **agent များစွာ** ကို အတူတကွ လက်တွဲအသုံးပြုနိုင်သည်။

**Workspace မှတ်ချက်:** agent တစ်ခုချင်းစီ၏ workspace သည် **default cwd** ဖြစ်ပြီး hard sandbox မဟုတ်ပါ။ Relative paths များသည် workspace အတွင်း ဖြေရှင်းသော်လည်း absolute paths များဖြင့် sandboxing မဖွင့်ထားပါက host အခြားနေရာများသို့ ရောက်ရှိနိုင်သည်။ [Sandboxing](/gateway/sandboxing) ကိုကြည့်ပါ။

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

**WhatsApp အကောင့်တစ်ခုတည်း** ကို အသုံးပြုထားပြီး **WhatsApp DM များ မတူညီခြင်း** ကို agent မတူညီသို့ လမ်းကြောင်းညွှန်ကြားနိုင်သည်။ ပို့သူ၏ E.164 (ဥပမာ `+15551234567`) ကို `peer.kind: "dm"` ဖြင့် ကိုက်ညီစေသည်။ ပြန်စာများသည် WhatsApp နံပါတ်တစ်ခုတည်းမှသာ ထွက်သည် (agent တစ်ခုချင်းစီအလိုက် ပို့သူ အမှတ်အသား မရှိပါ)။

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

**အကောင့်များစွာ** ကို ထောက်ပံ့သော ချန်နယ်များ (ဥပမာ WhatsApp) သည် login တစ်ခုချင်းစီကို ခွဲခြားရန် `accountId` ကို အသုံးပြုသည်။ `accountId` တစ်ခုချင်းစီကို agent မတူညီသို့ လမ်းကြောင်းညွှန်ကြားနိုင်သဖြင့် server တစ်ခုတည်းပေါ်တွင် ဖုန်းနံပါတ်များစွာကို session မရောနှောဘဲ လက်ခံနိုင်သည်။

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
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
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

- Tool allow/deny lists များသည် **tools** ဖြစ်ပြီး skills မဟုတ်ပါ။ Skill တစ်ခုက binary ကို လည်ပတ်ရန်လိုပါက `exec` ကို ခွင့်ပြုထားပြီး binary သည် sandbox အတွင်း ရှိနေကြောင်း သေချာပါစေ။
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

မှတ်ချက်: `setupCommand` သည် `sandbox.docker` အောက်တွင် ရှိပြီး container ဖန်တီးချိန် တစ်ကြိမ်သာ လည်ပတ်သည်။ Resolved scope သည် `"shared"` ဖြစ်နေပါက agent အလိုက် `sandbox.docker.*` overrides များကို လျစ်လျူရှုပါမည်။

**အကျိုးကျေးဇူးများ:**

- **လုံခြုံရေး သီးခြားခွဲခြားမှု**: ယုံကြည်မရသော agents များအတွက် tools များကို ကန့်သတ်နိုင်သည်
- **အရင်းအမြစ် ထိန်းချုပ်မှု**: agent တချို့ကို sandbox အတွင်းထားပြီး အခြားများကို host ပေါ်တွင် ထားနိုင်သည်
- **မူဝါဒ လိုက်လျောညီထွေမှု**: agent တစ်ခုချင်းစီအလိုက် ခွင့်ပြုချက် မတူညီနိုင်သည်

မှတ်ချက်: `tools.elevated` သည် **global** ဖြစ်ပြီး ပို့သူအခြေခံ ဖြစ်သည်; agent အလိုက် မပြင်ဆင်နိုင်ပါ။ Agent အလိုက် ကန့်သတ်ချက်များလိုအပ်ပါက `agents.list[].tools` ကို အသုံးပြု၍ `exec` ကို ငြင်းပယ်ပါ။
Group ကို ရည်ညွှန်းလိုပါက @mentions များကို ရည်ရွယ်ထားသော agent သို့ သေချာစွာ ချိတ်ဆက်နိုင်ရန် `agents.list[].groupChat.mentionPatterns` ကို အသုံးပြုပါ။

အသေးစိတ် ဥပမာများအတွက် [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) ကိုကြည့်ပါ။
