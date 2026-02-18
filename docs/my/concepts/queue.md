---
summary: "အဝင် auto-reply အလုပ်လုပ်ဆောင်မှုများကို အစဉ်လိုက်လုပ်ဆောင်စေရန် Command queue ဒီဇိုင်း"
read_when:
  - Auto-reply အကောင်အထည်ဖော်မှု သို့မဟုတ် concurrency ကို ပြောင်းလဲသောအခါ
title: "Command Queue"
---

# Command Queue (2026-01-16)

အဝင် auto-reply အလုပ်လုပ်ဆောင်မှုများကို (ချန်နယ်အားလုံး) အတွင်းပိုင်း သေးငယ်သော in-process queue တစ်ခုမှတစ်ဆင့် အစဉ်လိုက်လုပ်ဆောင်စေပြီး agent အလုပ်လုပ်ဆောင်မှုများ အပြန်အလှန်တိုက်ခိုက်မှု မဖြစ်စေရန် ကာကွယ်ထားသည်။ ထိုအပြင် session များအကြား လုံခြုံစိတ်ချရသော parallelism ကို ဆက်လက်ခွင့်ပြုထားသည်။

## Why

- Auto-reply အလုပ်လုပ်ဆောင်မှုများသည် ကုန်ကျစရိတ်မြင့်မားနိုင်ပြီး (LLM ခေါ်ဆိုမှုများ) အဝင်မက်ဆေ့ချ်များ အချိန်နီးနီးကပ်ကပ် ရောက်ရှိလာသောအခါ အပြန်အလှန်တိုက်ခိုက်မှု ဖြစ်နိုင်သည်။
- အစဉ်လိုက်လုပ်ဆောင်ခြင်းသည် မျှဝေအရင်းအမြစ်များ (session ဖိုင်များ၊ logs၊ CLI stdin) အတွက် ယှဉ်ပြိုင်မှုကို ရှောင်ရှားပေးပြီး upstream rate limits ထိခိုက်နိုင်ခြေကို လျှော့ချပေးသည်။

## How it works

- Lane ကို သတိပြုသော FIFO queue တစ်ခုသည် lane တစ်ခုချင်းစီကို စိတ်ကြိုက်သတ်မှတ်နိုင်သော concurrency ကန့်သတ်ချက်ဖြင့် ထုတ်လုပ်လုပ်ဆောင်သည် (မသတ်မှတ်ထားသော lane များအတွက် မူလသတ်မှတ်ချက် 1; main သည် မူလ 4၊ subagent သည် 8)။
- `runEmbeddedPiAgent` သည် **session key** (lane `session:<key>`) အလိုက် enqueue ပြုလုပ်ပြီး session တစ်ခုစီတွင် တစ်ချိန်တည်း active run တစ်ခုသာ ရှိရန် အာမခံပေးသည်။
- Session run တစ်ခုချင်းစီကို ထို့နောက် **global lane** (`main` မူလ) ထဲသို့ ထည့်သွင်းကာ စုစုပေါင်း parallelism ကို `agents.defaults.maxConcurrent` ဖြင့် ကန့်သတ်ထားသည်။
- Verbose logging ဖွင့်ထားသောအခါ စတင်မလုပ်မီ ~2 စက္ကန့်ကျော် စောင့်ဆိုင်းခဲ့ရပါက queued runs များသည် အတိုချုံး အသိပေးချက်တစ်ခု ထုတ်ပေးမည်ဖြစ်သည်။
- Typing indicators များသည် enqueue လုပ်ချိန်တွင် ချန်နယ်မှ ထောက်ပံ့ပါက ချက်ချင်း လုပ်ဆောင်သွားမည်ဖြစ်ပြီး မိမိအလှည့်ကို စောင့်နေစဉ် အသုံးပြုသူ အတွေ့အကြုံ မပြောင်းလဲစေရန် ဖြစ်သည်။

## Queue modes (per channel)

အဝင်မက်ဆေ့ချ်များသည် လက်ရှိ run ကို ထိန်းညှိနိုင်သည်၊ နောက်ထပ် turn ကို စောင့်နိုင်သည်၊ သို့မဟုတ် နှစ်ခုစလုံးကို ပြုလုပ်နိုင်သည်–

- `steer`: inject immediately into the current run (cancels pending tool calls after the next tool boundary). If not streaming, falls back to followup.
- `followup`: လက်ရှိ run ပြီးဆုံးပြီးနောက် နောက် agent turn အတွက် enqueue ပြုလုပ်ခြင်း။
- `collect`: coalesce all queued messages into a **single** followup turn (default). If messages target different channels/threads, they drain individually to preserve routing.
- `steer-backlog` (aka `steer+backlog`): ယခု steer ပြုလုပ်ပြီး **အပြင်** followup turn အတွက် မက်ဆေ့ချ်ကို သိမ်းဆည်းထားခြင်း။
- `interrupt` (legacy): ထို session အတွက် active run ကို ဖျက်သိမ်းပြီး နောက်ဆုံးရ မက်ဆေ့ချ်ကို လုပ်ဆောင်ခြင်း။
- `queue` (legacy alias): `steer` နှင့် အတူတူ ဖြစ်သည်။

Steer-backlog means you can get a followup response after the steered run, so
streaming surfaces can look like duplicates. Prefer `collect`/`steer` if you want
one response per inbound message.
Send `/queue collect` as a standalone command (per-session) or set `messages.queue.byChannel.discord: "collect"`.

Defaults (config တွင် မသတ်မှတ်ထားသောအခါ):

- Surface အားလုံး → `collect`

`messages.queue` မှတစ်ဆင့် global အဖြစ် သို့မဟုတ် channel အလိုက် ပြင်ဆင်နိုင်သည်–

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Queue options

Options များသည် `followup`, `collect`, နှင့် `steer-backlog` (နှင့် followup သို့ ပြန်ကျသောအခါ `steer`) အတွက် အသုံးချသည်–

- `debounceMs`: followup turn စတင်မီ တိတ်ဆိတ်မှုကို စောင့်ခြင်း (“continue, continue” ကို ကာကွယ်သည်)။
- `cap`: session တစ်ခုလျှင် queued မက်ဆေ့ချ် အများဆုံးအရေအတွက်။
- `drop`: overflow policy (`old`, `new`, `summarize`)။

Summarize keeps a short bullet list of dropped messages and injects it as a synthetic followup prompt.
Defaults: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Per-session overrides

- `/queue <mode>` ကို standalone command အဖြစ် ပို့၍ လက်ရှိ session အတွက် mode ကို သိမ်းဆည်းနိုင်သည်။
- Options များကို ပေါင်းစပ်အသုံးပြုနိုင်သည်– `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` သို့မဟုတ် `/queue reset` သည် session override ကို ဖျက်ရှင်းသည်။

## Scope and guarantees

- Gateway reply pipeline ကို အသုံးပြုသော အဝင်ချန်နယ်များအားလုံးရှိ auto-reply agent run များအတွက် သက်ရောက်သည် (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat စသည်)။
- မူလ lane (`main`) သည် inbound + main heartbeats အတွက် process အဆင့်တွင် မျှဝေထားသည်; session များကို parallel လုပ်ဆောင်ရန် `agents.defaults.maxConcurrent` ကို သတ်မှတ်ပါ။
- အဝင်တုံ့ပြန်မှုများကို မပိတ်ဆို့ဘဲ background jobs များကို parallel လုပ်ဆောင်နိုင်ရန် အပို lane များ (ဥပမာ `cron`, `subagent`) ရှိနိုင်သည်။
- Per-session lanes များသည် session တစ်ခုကို agent run တစ်ခုသာ တစ်ချိန်တည်း ထိတွေ့စေရန် အာမခံပေးသည်။
- အပြင်ဘက် dependency များ သို့မဟုတ် background worker threads မရှိပါ; TypeScript + promises သာ အသုံးပြုထားသည်။

## Troubleshooting

- Commands များ ပိတ်နေသကဲ့သို့ ထင်ရပါက verbose logs ကို ဖွင့်ပြီး queue သည် ထုတ်လုပ်လုပ်ဆောင်နေကြောင်း အတည်ပြုရန် “queued for …ms” စာကြောင်းများကို ကြည့်ပါ။
- Queue အနက်ကို သိလိုပါက verbose logs ကို ဖွင့်ပြီး queue timing စာကြောင်းများကို စောင့်ကြည့်ပါ။
