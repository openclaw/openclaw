---
summary: "ဥပမာများနှင့်အတူ ~/.openclaw/openclaw.json အတွက် ဖွဲ့စည်းပြင်ဆင်မှု ရွေးချယ်စရာများ အားလုံး"
read_when:
  - ဖွဲ့စည်းပြင်ဆင်မှု အကွက်များ ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
title: "ဖွဲ့စည်းပြင်ဆင်ခြင်း"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:44Z
---

# ဖွဲ့စည်းပြင်ဆင်ခြင်း 🔧

OpenClaw သည် `~/.openclaw/openclaw.json` မှ **JSON5** ဖွဲ့စည်းပြင်ဆင်မှု (မှတ်ချက်များ + နောက်ဆုံး ကော်မာများ ခွင့်ပြု) ကို ရွေးချယ်နိုင်သည့် အနေဖြင့် ဖတ်ရှုသည်။

ဖိုင် မရှိပါက OpenClaw သည် လုံခြုံရေးအဆင်ပြေသည့် မူလတန်ဖိုးများ (ထည့်သွင်းထားသော Pi agent + ပို့သူတစ်ဦးချင်းစီအလိုက် ဆက်ရှင်များ + အလုပ်ခွင် `~/.openclaw/workspace`) ကို အသုံးပြုသည်။ ပုံမှန်အားဖြင့် ဖွဲ့စည်းပြင်ဆင်မှုကို လိုအပ်သည့်အခါများမှာ—

- ဘော့ကို လှုံ့ဆော်နိုင်သူများကို ကန့်သတ်ရန် (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom` စသည်)
- အုပ်စု allowlist များနှင့် mention အပြုအမူကို ထိန်းချုပ်ရန် (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- မက်ဆေ့ချ် prefix များကို စိတ်ကြိုက်ပြင်ဆင်ရန် (`messages`)
- agent ၏ အလုပ်ခွင်ကို သတ်မှတ်ရန် (`agents.defaults.workspace` သို့မဟုတ် `agents.list[].workspace`)
- ထည့်သွင်းထားသော agent ၏ မူလတန်ဖိုးများ (`agents.defaults`) နှင့် ဆက်ရှင် အပြုအမူ (`session`) ကို ချိန်ညှိရန်
- အေးဂျင့်တစ်ခုချင်းစီအလိုက် အထောက်အထားကို သတ်မှတ်ရန် (`agents.list[].identity`)

> **ဖွဲ့စည်းပြင်ဆင်ခြင်း အသစ်ဖြစ်ပါသလား?** အသေးစိတ်ရှင်းလင်းချက်များပါဝင်သည့် ပြည့်စုံသော ဥပမာများအတွက် [Configuration Examples](/gateway/configuration-examples) လမ်းညွှန်ကို ကြည့်ပါ။

## တင်းကျပ်သော ဖွဲ့စည်းပြင်ဆင်မှု စစ်ဆေးခြင်း

OpenClaw သည် schema နှင့် အပြည့်အဝ ကိုက်ညီသော ဖွဲ့စည်းပြင်ဆင်မှုများကိုသာ လက်ခံသည်။
မသိသော ကီးများ၊ အမျိုးအစား မမှန်ကန်ခြင်းများ သို့မဟုတ် တန်ဖိုး မမှန်ကန်ခြင်းများ ဖြစ်ပါက လုံခြုံရေးအတွက် Gateway ကို **စတင်မလုပ်ပါ**။

စစ်ဆေးမှု မအောင်မြင်သည့်အခါ—

- Gateway မဖွင့်ပါ။
- ရောဂါရှာဖွေရေး အမိန့်များသာ ခွင့်ပြုသည် (ဥပမာ—`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`)။
- ပြဿနာများကို တိတိကျကျ ကြည့်ရန် `openclaw doctor` ကို ပြုလုပ်ပါ။
- ပြောင်းလဲမှု/ပြုပြင်မှုများကို လုပ်ဆောင်ရန် `openclaw doctor --fix` (သို့မဟုတ် `--yes`) ကို အသုံးပြုပါ။

Doctor သည် သင်က အတည်ပြု၍ `--fix`/`--yes` ကို ရွေးချယ်မထားပါက မည်သည့် ပြောင်းလဲမှုကိုမျှ မရေးသားပါ။

## Schema + UI အညွှန်းများ

Gateway သည် UI တည်းဖြတ်သူများအတွက် ဖွဲ့စည်းပြင်ဆင်မှု၏ JSON Schema ကို `config.schema` မှတစ်ဆင့် ဖော်ထုတ်ပေးသည်။
Control UI သည် ထို schema မှ ဖောင်ကို ရေးဆွဲပြီး **Raw JSON** တည်းဖြတ်ကိရိယာကို အရေးပေါ် ထွက်ပေါက်အဖြစ် ပံ့ပိုးသည်။

ချန်နယ် ပလဂင်များနှင့် တိုးချဲ့မှုများသည် ၎င်းတို့၏ ဖွဲ့စည်းပြင်ဆင်မှုအတွက် schema + UI အညွှန်းများကို မှတ်ပုံတင်နိုင်ပြီး၊ အက်ပ်များအနှံ့တွင် schema ကို အခြေခံထားသည့် ဆက်တင်များကို hard-coded ဖောင်များ မလိုအပ်ဘဲ ထိန်းသိမ်းနိုင်သည်။

အညွှန်းများ (တံဆိပ်များ၊ အုပ်စုခွဲခြင်း၊ အရေးကြီး အကွက်များ) ကို schema နှင့်အတူ ပို့ပေးသဖြင့် ကလိုင်းယင့်များသည် ဖွဲ့စည်းပြင်ဆင်မှု အကြောင်းအရာကို hard-code မလုပ်ဘဲ ပိုမိုကောင်းမွန်သော ဖောင်များကို ပြသနိုင်သည်။

## အသုံးချ + ပြန်လည်စတင်ခြင်း (RPC)

`config.apply` ကို အသုံးပြု၍ ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံကို စစ်ဆေး + ရေးသားပြီး Gateway ကို တစ်ချက်တည်းဖြင့် ပြန်လည်စတင်နိုင်သည်။
၎င်းသည် restart sentinel ကို ရေးသားပြီး Gateway ပြန်လည်စတင်ပြီးနောက် နောက်ဆုံး အသုံးပြုနေသည့် ဆက်ရှင်ကို ping လုပ်သည်။

သတိပေးချက်: `config.apply` သည် **ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံ** ကို အစားထိုးသည်။ အကွက်အနည်းငယ်သာ ပြောင်းလိုပါက `config.patch` သို့မဟုတ် `openclaw config set` ကို အသုံးပြုပါ။ `~/.openclaw/openclaw.json` ၏ မိတ္တူကို သိမ်းဆည်းထားပါ။

ပါရာမီတာများ—

- `raw` (string) — ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံအတွက် JSON5 payload
- `baseHash` (ရွေးချယ်နိုင်) — `config.get` မှ config hash (ဖွဲ့စည်းပြင်ဆင်မှု ရှိပြီးသားဖြစ်လျှင် လိုအပ်)
- `sessionKey` (ရွေးချယ်နိုင်) — wake-up ping အတွက် နောက်ဆုံး အသုံးပြုနေသည့် ဆက်ရှင် ကီး
- `note` (ရွေးချယ်နိုင်) — restart sentinel တွင် ထည့်သွင်းမည့် မှတ်ချက်
- `restartDelayMs` (ရွေးချယ်နိုင်) — ပြန်လည်စတင်မည့် အချိန် နှောင့်နှေးမှု (မူလ 2000)

ဥပမာ (`gateway call` မှတစ်ဆင့်)—

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## အစိတ်အပိုင်း အပ်ဒိတ်များ (RPC)

`config.patch` ကို အသုံးပြု၍ ရှိပြီးသား ဖွဲ့စည်းပြင်ဆင်မှုထဲသို့ အစိတ်အပိုင်း အပ်ဒိတ်ကို ပေါင်းထည့်နိုင်ပြီး ဆိုင်မဆိုင်သော ကီးများကို မဖျက်ဆီးပါ။
၎င်းသည် JSON merge patch semantics ကို အသုံးပြုသည်—

- object များကို recursive ပေါင်းစည်းသည်
- `null` သည် ကီးကို ဖျက်သည်
- array များကို အစားထိုးသည်  
  `config.apply` ကဲ့သို့ပင် စစ်ဆေးခြင်း၊ ရေးသားခြင်း၊ restart sentinel သိမ်းဆည်းခြင်းနှင့် Gateway ပြန်လည်စတင်မှုကို အချိန်ဇယားချသည် (`sessionKey` ပေးထားလျှင် wake လုပ်နိုင်သည်)။

ပါရာမီတာများ—

- `raw` (string) — ပြောင်းလဲမည့် ကီးများသာ ပါဝင်သည့် JSON5 payload
- `baseHash` (လိုအပ်) — `config.get` မှ config hash
- `sessionKey` (ရွေးချယ်နိုင်) — wake-up ping အတွက် နောက်ဆုံး ဆက်ရှင် ကီး
- `note` (ရွေးချယ်နိုင်) — restart sentinel အတွက် မှတ်ချက်
- `restartDelayMs` (ရွေးချယ်နိုင်) — ပြန်လည်စတင်မည့် အချိန် နှောင့်နှေးမှု (မူလ 2000)

ဥပမာ—

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## အနည်းဆုံး ဖွဲ့စည်းပြင်ဆင်မှု (အကြံပြုထားသော စတင်ချက်)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

မူလ image ကို တစ်ကြိမ် တည်ဆောက်ရန်—

```bash
scripts/sandbox-setup.sh
```

## ကိုယ်တိုင်-ချက် မုဒ် (အုပ်စု ထိန်းချုပ်မှုအတွက် အကြံပြု)

အုပ်စုများတွင် WhatsApp @-mentions များကို ဘော့က မတုံ့ပြန်စေရန် (တိကျသော စာသား trigger များသာ တုံ့ပြန်စေရန်)—

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Config Includes (`$include`)

`$include` ညွှန်ကြားချက်ကို အသုံးပြု၍ ဖွဲ့စည်းပြင်ဆင်မှုကို ဖိုင်အများအပြားအဖြစ် ခွဲနိုင်သည်။ ၎င်းသည်—

- ကြီးမားသော ဖွဲ့စည်းပြင်ဆင်မှုများကို စီမံရန် (ဥပမာ—client တစ်ခုချင်းစီအလိုက် agent သတ်မှတ်ချက်များ)
- ပတ်ဝန်းကျင်များအကြား အများသုံး ဆက်တင်များကို မျှဝေရန်
- အရေးကြီးသော ဖွဲ့စည်းပြင်ဆင်မှုများကို ခွဲထားရန်

### အခြေခံ အသုံးပြုနည်း

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### ပေါင်းစည်းမှု အပြုအမူ

- **ဖိုင်တစ်ဖိုင်**: `$include` ပါဝင်သည့် object ကို အစားထိုးသည်
- **ဖိုင် array**: အစဉ်လိုက် Deep-merge လုပ်သည် (နောက်ပိုင်းဖိုင်များက အရင်ဖိုင်များကို အစားထိုး)
- **Sibling keys ပါရှိလျှင်**: include ပြီးနောက် sibling keys များကို ပေါင်းစည်းသည် (include တန်ဖိုးများကို အစားထိုး)
- **Sibling keys + arrays/primitives**: မထောက်ပံ့ပါ (include လုပ်သော အကြောင်းအရာသည် object ဖြစ်ရမည်)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Nested includes

Include လုပ်ထားသော ဖိုင်များတွင်လည်း `$include` ညွှန်ကြားချက်များ ပါဝင်နိုင်သည် (အများဆုံး အဆင့် 10)—

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### လမ်းကြောင်း ဖြေရှင်းခြင်း

- **Relative paths**: include လုပ်သော ဖိုင်၏ လမ်းကြောင်းအပေါ် မူတည်၍ ဖြေရှင်းသည်
- **Absolute paths**: အတိုင်းအတာမပြောင်းဘဲ အသုံးပြုသည်
- **Parent directories**: `../` ကိုးကားချက်များ အလုပ်လုပ်သည်

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### အမှား ကိုင်တွယ်ခြင်း

- **ဖိုင် မရှိပါ**: ဖြေရှင်းထားသော လမ်းကြောင်းနှင့်အတူ အမှားကို ထုတ်ပြသည်
- **Parse အမှား**: include လုပ်ထားသော မည်သည့်ဖိုင် မအောင်မြင်သည်ကို ပြသသည်
- **Circular includes**: include ချိတ်ဆက်စဉ်ကို ထောက်လှမ်းပြီး အစီရင်ခံသည်

### ဥပမာ—ဖောက်သည်အများအတွက် ဥပဒေရေးရာ စနစ်တကျ ပြင်ဆင်မှု

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

---

_နောက်တစ်ဆင့်: [Agent Runtime](/concepts/agent)_ 🦞
