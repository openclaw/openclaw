---
summary: "ပြင်ပ CLI များ (signal-cli၊ legacy imsg) အတွက် RPC အဒက်တာများနှင့် Gateway ပုံစံများ"
read_when:
  - ပြင်ပ CLI ပေါင်းစည်းမှုများကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း အချိန်
  - RPC အဒက်တာများ (signal-cli၊ imsg) ကို ပြဿနာရှာဖွေပြုပြင်နေစဉ်
title: "RPC အဒက်တာများ"
x-i18n:
  source_path: reference/rpc.md
  source_hash: 06dc6b97184cc704
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:51Z
---

# RPC အဒက်တာများ

OpenClaw သည် JSON-RPC မှတစ်ဆင့် ပြင်ပ CLI များကို ပေါင်းစည်းအသုံးပြုသည်။ ယနေ့တွင် ပုံစံနှစ်မျိုးကို အသုံးပြုထားသည်။

## ပုံစံ A: HTTP daemon (signal-cli)

- `signal-cli` သည် HTTP ပေါ်တွင် JSON-RPC ဖြင့် daemon အဖြစ် လည်ပတ်သည်။
- Event stream သည် SSE (`/api/v1/events`) ဖြစ်သည်။
- Health probe: `/api/v1/check`။
- `channels.signal.autoStart=true` ဖြစ်သောအခါ OpenClaw သည် lifecycle ကို ပိုင်ဆိုင်ထိန်းချုပ်သည်။

တပ်ဆင်ခြင်းနှင့် endpoint များအတွက် [Signal](/channels/signal) ကို ကြည့်ပါ။

## ပုံစံ B: stdio child process (legacy: imsg)

> **မှတ်ချက်:** iMessage တပ်ဆင်မှုအသစ်များအတွက် [BlueBubbles](/channels/bluebubbles) ကို အသုံးပြုပါ။

- OpenClaw သည် `imsg rpc` ကို child process အဖြစ် စတင်ဖန်တီးသည် (legacy iMessage ပေါင်းစည်းမှု)။
- JSON-RPC သည် stdin/stdout မှတစ်ဆင့် line-delimited အနေဖြင့် လုပ်ဆောင်သည် (လိုင်းတစ်လိုင်းလျှင် JSON object တစ်ခု)။
- TCP port မလိုအပ်ဘဲ daemon လည်း မလိုအပ်ပါ။

အသုံးပြုသော အဓိက method များမှာ—

- `watch.subscribe` → notifications (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/diagnostics)

legacy တပ်ဆင်ခြင်းနှင့် လိပ်စာပေးခြင်း (`chat_id` ကို ဦးစားပေး) အတွက် [iMessage](/channels/imessage) ကို ကြည့်ပါ။

## Adapter လမ်းညွှန်ချက်များ

- Gateway သည် process ကို ပိုင်ဆိုင်သည် (provider lifecycle နှင့် start/stop ကို ချိတ်ဆက်ထားသည်)။
- RPC client များကို ခိုင်ခံ့အောင် ထိန်းသိမ်းပါ—timeout များ၊ exit ဖြစ်ပါက ပြန်လည်စတင်ခြင်း။
- ပြသစာသားများထက် တည်ငြိမ်သော ID များ (ဥပမာ `chat_id`) ကို ဦးစားပေးပါ။
