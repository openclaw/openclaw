---
summary: "Loopback WebChat static host နှင့် ချတ် UI အတွက် Gateway WebSocket အသုံးပြုမှု"
read_when:
  - WebChat ဝင်ရောက်အသုံးပြုမှုကို အမှားရှာဖွေခြင်း သို့မဟုတ် ဖွဲ့စည်းပြင်ဆင်ခြင်း ပြုလုပ်နေချိန်
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

အခြေအနေ: macOS/iOS SwiftUI ချတ် UI သည် Gateway WebSocket သို့ တိုက်ရိုက် ဆက်သွယ်နေပါသည်။

## အရာအမျိုးအစား

- gateway အတွက် native ချတ် UI တစ်ခု (embedded browser မပါ၊ local static server မလိုအပ်)။
- အခြား ချန်နယ်များနှင့် တူညီသော ဆက်ရှင်များနှင့် လမ်းကြောင်းသတ်မှတ်မှု စည်းမျဉ်းများကို အသုံးပြုသည်။
- သေချာတည်ငြိမ်သော လမ်းကြောင်းချမှတ်မှု: အဖြေများသည် အမြဲ WebChat သို့ ပြန်သွားသည်။

## အမြန်စတင်ရန်

1. gateway ကို စတင်ပါ။
2. WebChat UI (macOS/iOS app) သို့မဟုတ် Control UI ၏ chat tab ကို ဖွင့်ပါ။
3. gateway auth ကို ဖွဲ့စည်းပြင်ဆင်ထားကြောင်း သေချာပါစေ (loopback ပေါ်တွင်တောင် ပုံမှန်အားဖြင့် လိုအပ်သည်)။

## အလုပ်လုပ်ပုံ (အပြုအမူ)

- UI သည် Gateway WebSocket သို့ ချိတ်ဆက်ပြီး `chat.history`, `chat.send`, နှင့် `chat.inject` ကို အသုံးပြုသည်။
- `chat.inject` သည် assistant မှတ်ချက်ကို transcript ထဲသို့ တိုက်ရိုက် ထည့်သွင်းပြီး UI သို့ broadcast ပြုလုပ်သည် (agent run မရှိပါ)။
- မှတ်တမ်းကို အမြဲ gateway မှ ရယူသည် (local ဖိုင် စောင့်ကြည့်မှု မရှိပါ)။
- gateway ကို မရောက်ရှိနိုင်ပါက WebChat သည် ဖတ်ရှုနိုင်သည့် အခြေအနေသာ ဖြစ်သည်။

## အဝေးမှ အသုံးပြုခြင်း

- Remote mode သည် gateway WebSocket ကို SSH/Tailscale ဖြင့် တန်နယ်လုပ်ပေးသည်။
- သီးခြား WebChat server တစ်ခုကို မောင်းနှင်ရန် မလိုအပ်ပါ။

## ဖွဲ့စည်းပြင်ဆင်မှု ကိုးကားချက် (WebChat)

ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံ: [Configuration](/gateway/configuration)

ချန်နယ် ရွေးချယ်စရာများ:

- 40. သီးသန့် `webchat.*` block မရှိပါ။ 41. WebChat သည် အောက်တွင် ဖော်ပြထားသော gateway endpoint + auth settings များကို အသုံးပြုပါသည်။

ဆက်စပ်သော အထွေထွေ ရွေးချယ်စရာများ:

- `gateway.port`, `gateway.bind`: WebSocket ဟို့စ်/ပို့တ်။
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket auth။
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: အဝေးမှ gateway ပစ်မှတ်။
- `session.*`: ဆက်ရှင် သိမ်းဆည်းမှုနှင့် အဓိက ကီး မူလတန်ဖိုးများ။
