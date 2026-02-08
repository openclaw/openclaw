---
summary: "`openclaw system` အတွက် CLI ကိုးကားချက် (စနစ်ဖြစ်ရပ်များ၊ heartbeat၊ presence)"
read_when:
  - cron job မဖန်တီးဘဲ စနစ်ဖြစ်ရပ်တစ်ခုကို enqueue လုပ်ချင်သောအခါ
  - heartbeats ကို ဖွင့်ရန် သို့မဟုတ် ပိတ်ရန် လိုအပ်သောအခါ
  - စနစ် presence အချက်အလက်များကို စစ်ဆေးလိုသောအခါ
title: "စနစ်"
x-i18n:
  source_path: cli/system.md
  source_hash: 36ae5dbdec327f5a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:12Z
---

# `openclaw system`

Gateway（ဂိတ်ဝေး）အတွက် စနစ်အဆင့် အထောက်အကူကိရိယာများ — စနစ်ဖြစ်ရပ်များကို enqueue လုပ်ခြင်း၊ heartbeats ကို ထိန်းချုပ်ခြင်းနှင့် presence ကို ကြည့်ရှုခြင်း။

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

**main** ဆက်ရှင်တွင် စနစ်ဖြစ်ရပ်တစ်ခုကို enqueue လုပ်ပါ။ နောက်လာမည့် heartbeat သည် ၎င်းကို prompt အတွင်း `System:` လိုင်းအဖြစ် ထည့်သွင်းပေးပါလိမ့်မည်။ heartbeat ကို ချက်ချင်း လှုံ့ဆော်ရန် `--mode now` ကို အသုံးပြုပါ; `next-heartbeat` သည် အချိန်ဇယားအတိုင်း နောက်တစ်ကြိမ် tick ကို စောင့်ပါသည်။

Flags:

- `--text <text>`: လိုအပ်သော စနစ်ဖြစ်ရပ် စာသား။
- `--mode <mode>`: `now` သို့မဟုတ် `next-heartbeat` (မူလသတ်မှတ်ချက်)။
- `--json`: စက်ဖြင့်ဖတ်ရှုနိုင်သော အထွက်။

## `system heartbeat last|enable|disable`

Heartbeat ထိန်းချုပ်မှုများ:

- `last`: နောက်ဆုံး heartbeat ဖြစ်ရပ်ကို ပြပါ။
- `enable`: heartbeats ကို ပြန်ဖွင့်ပါ (ပိတ်ထားခဲ့ပါက အသုံးပြုပါ)။
- `disable`: heartbeats ကို ခဏရပ်နားပါ။

Flags:

- `--json`: စက်ဖြင့်ဖတ်ရှုနိုင်သော အထွက်။

## `system presence`

Gateway（ဂိတ်ဝေး）က သိထားသော လက်ရှိ စနစ် presence အချက်အလက်များကို စာရင်းပြုစုပါ (နိုဒ်များ၊ instance များနှင့် ဆင်တူသော အခြေအနေ လိုင်းများ)။

Flags:

- `--json`: စက်ဖြင့်ဖတ်ရှုနိုင်သော အထွက်။

## Notes

- လက်ရှိ config (local သို့မဟုတ် remote) မှတစ်ဆင့် ချိတ်ဆက်နိုင်သော Gateway（ဂိတ်ဝေး） တစ်ခု လည်ပတ်နေမှု လိုအပ်ပါသည်။
- စနစ်ဖြစ်ရပ်များသည် ယာယီသာဖြစ်ပြီး restart ပြုလုပ်ပြီးနောက် မသိမ်းဆည်းထားပါ။
