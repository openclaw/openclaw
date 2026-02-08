---
summary: "OpenProse: OpenClaw အတွင်းရှိ .prose workflow များ၊ slash command များနှင့် state"
read_when:
  - .prose workflow များကို လုပ်ဆောင်ရန် သို့မဟုတ် ရေးသားရန် လိုအပ်သည့်အခါ
  - OpenProse plugin ကို ဖွင့်လိုသည့်အခါ
  - state သိမ်းဆည်းပုံကို နားလည်ရန် လိုအပ်သည့်အခါ
title: "OpenProse"
x-i18n:
  source_path: prose.md
  source_hash: 53c161466d278e5f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:52Z
---

# OpenProse

OpenProse သည် AI ဆက်ရှင်များကို စီမံညွှန်းရန် အသုံးပြုသည့် သယ်ဆောင်အသုံးပြုနိုင်သော၊ markdown ကို အခြေခံသည့် workflow ဖော်မတ်တစ်ခုဖြစ်သည်။ OpenClaw တွင် ၎င်းကို plugin အဖြစ် ထည့်သွင်းပေးထားပြီး OpenProse skill pack တစ်ခုနှင့် `/prose` slash command တစ်ခုကို တပ်ဆင်ပေးသည်။ Program များသည် `.prose` ဖိုင်များအဖြစ် ရှိနေပြီး ထိန်းချုပ်ထားသော control flow ဖြင့် sub-agent အများအပြားကို ဖန်တီးနိုင်သည်။

တရားဝင်ဝဘ်ဆိုက်: [https://www.prose.md](https://www.prose.md)

## လုပ်ဆောင်နိုင်သည့်အရာများ

- ပြတ်သားသော parallelism ပါဝင်သည့် multi-agent သုတေသနနှင့် အကျဉ်းချုပ်ရေးသားခြင်း။
- ပြန်လည်အသုံးချနိုင်ပြီး အတည်ပြုချက်အတွက် လုံခြုံသော workflow များ (code review, incident triage, content pipeline များ)။
- ပံ့ပိုးထားသော agent runtime များအကြား လည်ပတ်အသုံးပြုနိုင်သည့် ပြန်လည်အသုံးချနိုင်သော `.prose` program များ။

## ထည့်သွင်းခြင်းနှင့် ဖွင့်ခြင်း

Bundled plugin များကို မူလအနေဖြင့် ပိတ်ထားသည်။ OpenProse ကို ဖွင့်ရန်:

```bash
openclaw plugins enable open-prose
```

Plugin ကို ဖွင့်ပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

Dev/local checkout: `openclaw plugins install ./extensions/open-prose`

ဆက်စပ်စာတမ်းများ: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills)။

## Slash command

OpenProse သည် အသုံးပြုသူက ခေါ်ယူနိုင်သော skill command အဖြစ် `/prose` ကို မှတ်ပုံတင်ပေးသည်။ ၎င်းသည် OpenProse VM ညွှန်ကြားချက်များသို့ လမ်းကြောင်းချပြီး အတွင်းပိုင်းတွင် OpenClaw ကိရိယာများကို အသုံးပြုသည်။

အများဆုံးအသုံးပြုသော command များ:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## ဥပမာ: ရိုးရှင်းသော `.prose` ဖိုင်တစ်ခု

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## ဖိုင်တည်နေရာများ

OpenProse သည် သင့် workspace အတွင်းရှိ `.prose/` အောက်တွင် state ကို သိမ်းဆည်းထားသည်။

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

အသုံးပြုသူအဆင့် persistent agent များသည် အောက်ပါနေရာတွင် ရှိသည်။

```
~/.prose/agents/
```

## State မုဒ်များ

OpenProse သည် state backend များစွာကို ပံ့ပိုးပေးသည်။

- **filesystem** (မူလ): `.prose/runs/...`
- **in-context**: ယာယီ၊ program သေးငယ်များအတွက်
- **sqlite** (စမ်းသပ်အဆင့်): `sqlite3` binary လိုအပ်သည်
- **postgres** (စမ်းသပ်အဆင့်): `psql` နှင့် connection string တစ်ခု လိုအပ်သည်

မှတ်ချက်များ:

- sqlite/postgres သည် opt-in ဖြစ်ပြီး စမ်းသပ်အဆင့်သာ ဖြစ်သည်။
- postgres အထောက်အထားများသည် sub-agent log များထဲသို့ စီးဝင်နိုင်သဖြင့် အခွင့်အရေးအနည်းဆုံးသာ ပေးထားသော သီးသန့် DB ကို အသုံးပြုပါ။

## အဝေးမှ program များ

`/prose run <handle/slug>` သည် `https://p.prose.md/<handle>/<slug>` သို့ ဖြေရှင်းသတ်မှတ်သည်။
တိုက်ရိုက် URL များကို အတိုင်းအတာမပြောင်းဘဲ fetch လုပ်သည်။ ၎င်းသည် `web_fetch` ကိရိယာကို အသုံးပြုသည် (POST အတွက် `exec`)။

## OpenClaw runtime ချိတ်ဆက်မှု

OpenProse program များကို OpenClaw primitive များနှင့် ချိတ်ဆက်ထားသည်။

| OpenProse အယူအဆ                 | OpenClaw ကိရိယာ  |
| ------------------------------- | ---------------- |
| Session ဖန်တီးခြင်း / Task tool | `sessions_spawn` |
| ဖိုင် ဖတ်/ရေး                   | `read` / `write` |
| Web fetch                       | `web_fetch`      |

သင့် tool allowlist တွင် အဆိုပါကိရိယာများကို ပိတ်ထားပါက OpenProse program များ မအောင်မြင်ပါ။ [Skills config](/tools/skills-config) ကို ကြည့်ပါ။

## လုံခြုံရေးနှင့် အတည်ပြုချက်များ

`.prose` ဖိုင်များကို code ကဲ့သို့ ဆက်ဆံပါ။ လည်ပတ်မည်မီ ပြန်လည်သုံးသပ်ပါ။ ဘေးထွက်သက်ရောက်မှုများကို ထိန်းချုပ်ရန် OpenClaw tool allowlist များနှင့် approval gate များကို အသုံးပြုပါ။

သတ်မှတ်ချက်တိကျပြီး အတည်ပြုချက်ဖြင့် ထိန်းချုပ်ထားသော workflow များအတွက် [Lobster](/tools/lobster) နှင့် နှိုင်းယှဉ်ကြည့်ပါ။
