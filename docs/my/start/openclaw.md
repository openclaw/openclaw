---
summary: "လုံခြုံရေးသတိပေးချက်များပါဝင်သည့် OpenClaw ကို ကိုယ်ပိုင်အကူအညီပေးသူအဖြစ် အသုံးပြုရန် အဆုံးမှအဆုံး လမ်းညွှန်"
read_when:
  - အကူအညီပေးသူ အင်စတန့်စ်အသစ်ကို စတင်မိတ်ဆက်ခြင်း
  - လုံခြုံရေး/ခွင့်ပြုချက် အကျိုးဆက်များကို ပြန်လည်သုံးသပ်ခြင်း
title: "ကိုယ်ပိုင်အကူအညီပေးသူ တပ်ဆင်ခြင်း"
---

# OpenClaw ဖြင့် ကိုယ်ပိုင်အကူအညီပေးသူ တည်ဆောက်ခြင်း

ပထမအကြိမ် agent run လုပ်စဉ် gateway host ပေါ်မှာ ဘာတွေ ဖြစ်ပေါ်လာတယ်ဆိုတာကို [Bootstrapping](/start/bootstrapping) မှာ ကြည့်ပါ။ OpenClaw သည် **Pi** agents များအတွက် WhatsApp + Telegram + Discord + iMessage gateway ဖြစ်သည်။ Plugins များက Mattermost ကို ထပ်ပေါင်းပေးသည်။

## ⚠️ လုံခြုံရေးကို အရင်ဆုံး

သင်သည် အေးဂျင့်တစ်ခုကို အောက်ပါအရာများ ပြုလုပ်နိုင်သည့် အနေအထားတွင် ထားရှိနေပါသည်—

- သင့်စက်ပေါ်တွင် အမိန့်များကို လုပ်ဆောင်နိုင်ခြင်း (သင့် Pi ကိရိယာ ဖွဲ့စည်းမှုအပေါ် မူတည်၍)
- သင့် workspace အတွင်း ဖိုင်များကို ဖတ်/ရေးနိုင်ခြင်း
- WhatsApp/Telegram/Discord/Mattermost (plugin) မှတစ်ဆင့် မက်ဆေ့ချ်များ ပြန်လည်ပို့နိုင်ခြင်း

ထို့ကြောင့် စတင်ချိန်တွင် သတိထားပါ—

- `channels.whatsapp.allowFrom` ကို အမြဲ သတ်မှတ်ထားပါ (သင့်ကိုယ်ပိုင် Mac ကို အပြင်ကမ္ဘာသို့ ဖွင့်ထားခြင်း မပြုပါနှင့်)။
- အကူအညီပေးသူအတွက် WhatsApp နံပါတ်ကို သီးသန့် အသုံးပြုပါ။
- ဒီလမ်းညွှန်က "personal assistant" setup ဖြစ်သည် — အမြဲတမ်း အလုပ်လုပ်နေသော agent လို ပြုမူသည့် WhatsApp နံပါတ်တစ်ခုကို သီးသန့် အသုံးပြုခြင်းပါ။ Heartbeats များကို ယခု မိနစ် ၃၀ တစ်ကြိမ် အလိုအလျောက် သတ်မှတ်ထားသည်။

## ကြိုတင်လိုအပ်ချက်များ

- OpenClaw ကို ထည့်သွင်းတပ်ဆင်ပြီး စတင်မိတ်ဆက်ပြီးသားဖြစ်ရပါမည် — မပြီးသေးပါက [Getting Started](/start/getting-started) ကို ကြည့်ပါ
- အကူအညီပေးသူအတွက် ဖုန်းနံပါတ်တစ်ခု ထပ်မံလိုအပ်ပါသည် (SIM/eSIM/prepaid)

## ဖုန်းနှစ်လုံး အသုံးပြုသော တပ်ဆင်ပုံ (အကြံပြု)

သင်လိုချင်သည့် အနေအထားမှာ—

```mermaid
39. %%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#ffffff',
    'primaryTextColor': '#000000',
    'primaryBorderColor': '#000000',
    'lineColor': '#000000',
    'secondaryColor': '#f9f9fb',
    'tertiaryColor': '#ffffff',
    'clusterBkg': '#f9f9fb',
    'clusterBorder': '#000000',
    'nodeBorder': '#000000',
    'mainBkg': '#ffffff',
    'edgeLabelBackground': '#ffffff'
  }
}}%%
flowchart TB
    A["<b>Your Phone (personal)<br></b><br>Your WhatsApp<br>+1-555-YOU"] -- message --> B["<b>Second Phone (assistant)<br></b><br>Assistant WA<br>+1-555-ASSIST"]
    B -- linked via QR --> C["<b>Your Mac (openclaw)<br></b><br>Pi agent"]
```

setup ကို ယုံကြည်မလာသေးခင် `agents.defaults.heartbeat.every: "0m"` ကို သတ်မှတ်ပြီး ပိတ်ထားနိုင်သည်။ ဒါက သင်အများအားဖြင့် လိုချင်တာ မဟုတ်ပါဘူး။

## ၅ မိနစ်အတွင်း အမြန်စတင်ရန်

1. WhatsApp Web ကို ချိတ်ဆက်ပါ (QR ပြပါမည်; အကူအညီပေးသူဖုန်းဖြင့် စကန်ဖတ်ပါ):

```bash
openclaw channels login
```

2. Gateway ကို စတင်ပါ (ဆက်လက် လည်ပတ်နေအောင် ထားပါ):

```bash
openclaw gateway --port 18789
```

3. အနည်းဆုံး config ကို `~/.openclaw/openclaw.json` ထဲတွင် ထည့်ပါ:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

ယခု allowlist ထဲတွင် ပါဝင်သည့် သင့်ဖုန်းမှ အကူအညီပေးသူနံပါတ်သို့ မက်ဆေ့ချ်ပို့ပါ။

Onboarding ပြီးဆုံးသွားတဲ့အခါ dashboard ကို အလိုအလျောက် ဖွင့်ပြီး သန့်ရှင်းတဲ့ (token မပါသော) link ကို ပြပေးပါမယ်။ auth ကို မေးလာရင် `gateway.auth.token` ထဲက token ကို Control UI settings ထဲမှာ paste လုပ်ပါ။ နောက်မှ ပြန်ဖွင့်ရန်: `openclaw dashboard`

## အေးဂျင့်အတွက် workspace ပေးခြင်း (AGENTS)

OpenClaw သည် လုပ်ဆောင်ချက်ညွှန်ကြားချက်များနှင့် “မှတ်ဉာဏ်” ကို ၎င်း၏ workspace directory မှ ဖတ်ပါသည်။

ပုံမှန်အားဖြင့် OpenClaw က agent workspace အဖြစ် `~/.openclaw/workspace` ကို အသုံးပြုပြီး setup/agent ကို ပထမဆုံး run လုပ်တဲ့အခါ အလိုအလျောက် ဖန်တီးပေးပါမယ် (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` အပါအဝင်)။ `BOOTSTRAP.md` ကို workspace အသစ်တစ်ခု ဖြစ်တဲ့အခါမှသာ ဖန်တီးပါတယ် (သင် ဖျက်ပြီးနောက် ပြန်မပေါ်သင့်ပါဘူး)။ `MEMORY.md` က မလိုအပ်ရင် မထားလည်းရပါတယ် (အလိုအလျောက် မဖန်တီးပါ)၊ ရှိနေပါက ပုံမှန် session တွေအတွက် load လုပ်ပါမယ်။ Subagent sessions only inject `AGENTS.md` and `TOOLS.md`.

Tip: treat this folder like OpenClaw’s “memory” and make it a git repo (ideally private) so your `AGENTS.md` + memory files are backed up. git ကို install လုပ်ထားရင် workspace အသစ်တွေကို အလိုအလျောက် initialize လုပ်ပေးပါတယ်။

```bash
openclaw setup
```

Workspace အပြည့်အစုံ အပြင်အဆင်နှင့် အရန်ကူး လမ်းညွှန် — [Agent workspace](/concepts/agent-workspace)  
Memory workflow — [Memory](/concepts/memory)

ရွေးချယ်စရာ — `agents.defaults.workspace` ဖြင့် မတူညီသော workspace ကို ရွေးနိုင်ပါသည် (`~` ကို ပံ့ပိုးသည်)။

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Repo မှ ကိုယ်ပိုင် workspace ဖိုင်များကို ကိုယ်တိုင် ပို့နေပါက bootstrap ဖိုင် ဖန်တီးမှုကို အပြည့်အဝ ပိတ်နိုင်ပါသည်—

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## “အကူအညီပေးသူ” အဖြစ် ပြောင်းလဲစေသော config

OpenClaw သည် မူလအနေဖြင့် အကောင်းဆုံး အကူအညီပေးသူ ဖွဲ့စည်းမှုဖြင့် စတင်သော်လည်း အောက်ပါအရာများကို ပုံမှန်အားဖြင့် ချိန်ညှိလိုမည်ဖြစ်သည်—

- `SOUL.md` ထဲရှိ persona/ညွှန်ကြားချက်များ
- (လိုအပ်ပါက) thinking မူလသတ်မှတ်ချက်များ
- (ယုံကြည်စိတ်ချလာသောအခါ) heartbeats

ဥပမာ—

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## ဆက်ရှင်များနှင့် မှတ်ဉာဏ်

- ဆက်ရှင်ဖိုင်များ — `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- ဆက်ရှင် metadata (token အသုံးပြုမှု၊ နောက်ဆုံး route စသည်) — `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy — `~/.openclaw/sessions/sessions.json`)
- `/new` သို့မဟုတ် `/reset` က အဲ့ဒီ chat အတွက် session အသစ်တစ်ခု စတင်ပေးပါတယ် (`resetTriggers` ဖြင့် ပြင်ဆင်နိုင်သည်)။ တစ်ခုတည်း ပို့လိုက်ရင် agent က reset ဖြစ်ကြောင်း အတည်ပြုဖို့ hello တိုတို ပြန်ပါမယ်။
- `/compact [instructions]` သည် ဆက်ရှင် context ကို ချုံ့ပြီး ကျန်ရှိသော context budget ကို အစီရင်ခံပါသည်။

## Heartbeats (ကြိုတင်လုပ်ဆောင်သည့် မုဒ်)

ပုံမှန်အားဖြင့် OpenClaw က မိနစ် ၃၀ တိုင်း heartbeat ကို အောက်ပါ prompt နဲ့ run လုပ်ပါတယ်:
`Read HEARTBEAT.md if it exists (workspace context). 14. အဲဒါကို တိတိကျကျ လိုက်နာပါ။ 15. ယခင် chat တွေထဲက အလုပ်ဟောင်းတွေကို ခန့်မှန်းမထုတ်ပါနှင့်၊ ပြန်မပြောပါနှင့်။ 16. အာရုံစိုက်စရာ မရှိရင် HEARTBEAT_OK လို့ ပြန်ပါ။`
Set `agents.defaults.heartbeat.every: "0m"` to disable.

- `HEARTBEAT.md` ရှိသော်လည်း အကြောင်းအရာ မရှိသလောက် (အလွတ်လိုင်းများနှင့် `# Heading` ကဲ့သို့သော markdown headers များသာ) ဖြစ်ပါက API ခေါ်ယူမှုများ ချွေတာရန် OpenClaw သည် heartbeat ကို ကျော်လွှားပါသည်။
- ဖိုင် မရှိပါက heartbeat သည် ဆက်လက် လည်ပတ်ပြီး မော်ဒယ်က ဘာလုပ်မည်ကို ဆုံးဖြတ်ပါသည်။
- အေးဂျင့်က `HEARTBEAT_OK` ဖြင့် ပြန်ကြားပါက (အတိုချုံး padding ပါနိုင်သည် — `agents.defaults.heartbeat.ackMaxChars` ကို ကြည့်ပါ) ထို heartbeat အတွက် အပြင်သို့ ပို့ခြင်းကို OpenClaw က တားဆီးပါသည်။
- Heartbeats များသည် အေးဂျင့် အလှည့်အပြည့် လည်ပတ်ပါသည် — အချိန်ကာလကို တိုလျှင် token များ ပိုမို သုံးစွဲပါမည်။

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## မီဒီယာ အဝင်/အထွက်

အဝင် attachments (ပုံ/အသံ/စာရွက်စာတမ်း) များကို templates မှတစ်ဆင့် သင့်အမိန့်သို့ ထည့်သွင်းနိုင်ပါသည်—

- `{{MediaPath}}` (local temp ဖိုင်လမ်းကြောင်း)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (audio transcription ကို ဖွင့်ထားပါက)

17. agent က ထွက်သွားတဲ့ attachment တွေအတွက် ကိုယ်ပိုင်လိုင်းတစ်ကြောင်းမှာ `MEDIA:<path-or-url>` ကို ထည့်ပါ (space မပါ)။ ဥပမာ—

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw သည် ဤအရာများကို ထုတ်ယူပြီး စာသားနှင့်အတူ မီဒီယာအဖြစ် ပို့ပါသည်။

## လည်ပတ်ရေး စစ်ဆေးစာရင်း

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Logs များကို `/tmp/openclaw/` အောက်တွင် သိမ်းဆည်းပါသည် (မူလ — `openclaw-YYYY-MM-DD.log`)။

## နောက်တစ်ဆင့်များ

- WebChat — [WebChat](/web/webchat)
- Gateway လည်ပတ်ရေး — [Gateway runbook](/gateway)
- Cron + wakeups — [Cron jobs](/automation/cron-jobs)
- macOS menu bar အဖော်အက်ပ် — [OpenClaw macOS app](/platforms/macos)
- iOS နိုဒ် အက်ပ် — [iOS app](/platforms/ios)
- Android နိုဒ် အက်ပ် — [Android app](/platforms/android)
- Windows အခြေအနေ — [Windows (WSL2)](/platforms/windows)
- Linux အခြေအနေ — [Linux app](/platforms/linux)
- လုံခြုံရေး — [Security](/gateway/security)
