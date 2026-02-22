---
summary: "Gateway + CLI ဖြင့် Poll ပို့ခြင်း"
read_when:
  - Poll အထောက်အပံ့ ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - CLI သို့မဟုတ် Gateway မှ Poll ပို့ခြင်းကို အမှားရှာဖွေခြင်း
title: "Poll များ"
---

# Poll များ

## ပံ့ပိုးထားသော ချန်နယ်များ

- WhatsApp (web channel)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Options:

- `--channel`: `whatsapp` (default), `discord`, သို့မဟုတ် `msteams`
- `--poll-multi`: ရွေးချယ်မှုများကို အများအပြား ရွေးနိုင်ရန် ခွင့်ပြုသည်
- `--poll-duration-hours`: Discord သီးသန့် (မထည့်သွင်းပါက 24 ကို default အဖြစ် သတ်မှတ်သည်)

## Gateway RPC

Method: `poll`

Params:

- `to` (string, required)
- `question` (string, required)
- `options` (string[], required)
- `maxSelections` (number, optional)
- `durationHours` (number, optional)
- `channel` (string, optional, default: `whatsapp`)
- `idempotencyKey` (string, required)

## ချန်နယ်အလိုက် ကွာခြားချက်များ

- WhatsApp: ရွေးချယ်မှု 2-12 ခု၊ `maxSelections` သည် ရွေးချယ်မှု အရေအတွက်အတွင်း ဖြစ်ရမည်၊ `durationHours` ကို လျစ်လျူရှုသည်။
- Discord: ရွေးချယ်စရာ ၂-၁၀ ခု၊ `durationHours` ကို ၁-၇၆၈ နာရီအတွင်း ကန့်သတ်ထားသည် (default ၂၄)။ `maxSelections > 1` ဖြစ်ပါက multi-select ကို enable လုပ်ပေးသည်; Discord သည် တိကျသော ရွေးချယ်မှု အရေအတွက်ကို မထောက်ပံ့ပါ။
- MS Teams: Adaptive Card polls (OpenClaw မှ စီမံခန့်ခွဲသည်)။ Native poll API မရှိပါ; `durationHours` ကို လျစ်လျူရှုပါသည်။

## Agent tool (Message)

`message` tool ကို `poll` action ဖြင့် အသုံးပြုပါ (`to`, `pollQuestion`, `pollOption`, optional `pollMulti`, `pollDurationHours`, `channel`)။

မှတ်ချက်: Discord တွင် “အတိအကျ N ခု ရွေးချယ်ပါ” mode မရှိပါ; `pollMulti` သည် multi-select နှင့် ကိုက်ညီပါသည်။
Teams polls များကို Adaptive Cards အဖြစ် render လုပ်ပြီး `~/.openclaw/msteams-polls.json` တွင် မဲများကို မှတ်တမ်းတင်ရန် gateway သည် အွန်လိုင်းနေဆဲ ဖြစ်ရပါမည်။
