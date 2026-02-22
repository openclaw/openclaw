---
summary: "OpenProse: OpenClaw အတွင်းရှိ .prose workflow များ၊ slash command များနှင့် state"
read_when:
  - .prose workflow များကို လုပ်ဆောင်ရန် သို့မဟုတ် ရေးသားရန် လိုအပ်သည့်အခါ
  - OpenProse plugin ကို ဖွင့်လိုသည့်အခါ
  - state သိမ်းဆည်းပုံကို နားလည်ရန် လိုအပ်သည့်အခါ
title: "OpenProse"
---

# OpenProse

OpenProse သည် AI sessions များကို orchestration လုပ်ရန် portable ဖြစ်ပြီး markdown-first workflow format တစ်ခုဖြစ်ပါသည်။ OpenClaw တွင် ၎င်းကို OpenProse skill pack တစ်ခုနှင့် `/prose` slash command ကို install လုပ်ပေးသော plugin အဖြစ် ပါဝင်လာပါသည်။ Programs များသည် `.prose` files များတွင် ရှိပြီး explicit control flow ဖြင့် sub‑agents အများအပြားကို spawn လုပ်နိုင်ပါသည်။

တရားဝင်ဝဘ်ဆိုက်: [https://www.prose.md](https://www.prose.md)

## လုပ်ဆောင်နိုင်သည့်အရာများ

- ပြတ်သားသော parallelism ပါဝင်သည့် multi-agent သုတေသနနှင့် အကျဉ်းချုပ်ရေးသားခြင်း။
- ပြန်လည်အသုံးချနိုင်ပြီး အတည်ပြုချက်အတွက် လုံခြုံသော workflow များ (code review, incident triage, content pipeline များ)။
- ပံ့ပိုးထားသော agent runtime များအကြား လည်ပတ်အသုံးပြုနိုင်သည့် ပြန်လည်အသုံးချနိုင်သော `.prose` program များ။

## ထည့်သွင်းခြင်းနှင့် ဖွင့်ခြင်း

Bundled plugins များကို default အနေဖြင့် disabled လုပ်ထားပါသည်။ OpenProse ကို Enable လုပ်ရန်:

```bash
openclaw plugins enable open-prose
```

Plugin ကို ဖွင့်ပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

Dev/local checkout: `openclaw plugins install ./extensions/open-prose`

ဆက်စပ်စာတမ်းများ: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills)။

## Slash command

OpenProse သည် `/prose` ကို user-invocable skill command အဖြစ် register လုပ်ပါသည်။ ၎င်းသည် OpenProse VM instructions သို့ route လုပ်ပြီး အောက်ခြေတွင် OpenClaw tools များကို အသုံးပြုပါသည်။

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

`/prose run <handle/slug>` သည် `https://p.prose.md/<handle>/<slug>` သို့ resolve လုပ်ပါသည်။
Direct URLs များကို as-is အနေဖြင့် fetch လုပ်ပါသည်။ ဤအရာသည် `web_fetch` tool (သို့မဟုတ် POST အတွက် `exec`) ကို အသုံးပြုပါသည်။

## OpenClaw runtime ချိတ်ဆက်မှု

OpenProse program များကို OpenClaw primitive များနှင့် ချိတ်ဆက်ထားသည်။

| OpenProse အယူအဆ                 | OpenClaw ကိရိယာ  |
| ------------------------------- | ---------------- |
| Session ဖန်တီးခြင်း / Task tool | `sessions_spawn` |
| ဖိုင် ဖတ်/ရေး                   | `read` / `write` |
| Web fetch                       | `web_fetch`      |

သင့် tool allowlist မှ ဤ tools များကို block လုပ်ထားပါက OpenProse programs များ အလုပ်မလုပ်ပါ။ [Skills config](/tools/skills-config) ကို ကြည့်ပါ။

## လုံခြုံရေးနှင့် အတည်ပြုချက်များ

`.prose` files များကို code ကဲ့သို့ ဆက်ဆံပါ။ Run မလုပ်မီ review လုပ်ပါ။ Side effects များကို ထိန်းချုပ်ရန် OpenClaw tool allowlists နှင့် approval gates များကို အသုံးပြုပါ။

သတ်မှတ်ချက်တိကျပြီး အတည်ပြုချက်ဖြင့် ထိန်းချုပ်ထားသော workflow များအတွက် [Lobster](/tools/lobster) နှင့် နှိုင်းယှဉ်ကြည့်ပါ။
