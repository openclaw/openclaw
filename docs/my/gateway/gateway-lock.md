---
summary: "WebSocket listener bind ကို အသုံးပြုသော Gateway singleton ကာကွယ်မှု"
read_when:
  - Gateway လုပ်ငန်းစဉ်ကို လည်ပတ်နေစဉ် သို့မဟုတ် debug လုပ်နေစဉ်
  - တစ်ခုတည်းသာ လည်ပတ်နိုင်ရေးကို စစ်ဆေးလေ့လာနေစဉ်
title: "Gateway Lock"
---

# Gateway lock

နောက်ဆုံးအပ်ဒိတ်: 2025-12-11

## အကြောင်းရင်း

- ဟို့စ်တစ်ခုတည်းပေါ်တွင် base port တစ်ခုစီအတွက် Gateway instance တစ်ခုတည်းသာ လည်ပတ်နိုင်စေရန် သေချာစေခြင်း၊ ထပ်တိုး Gateway များသည် သီးခြား profile များနှင့် မတူညီသော port များကို အသုံးပြုရမည်။
- crash သို့မဟုတ် SIGKILL ဖြစ်သော်လည်း အဟောင်း lock ဖိုင်များ မကျန်ရစ်စေရန်။
- control port ကို အခြားသူက အသုံးပြုနေပါက ရှင်းလင်းသော အမှားဖြင့် ချက်ချင်း မအောင်မြင်စေခြင်း။

## လုပ်ဆောင်ပုံ (Mechanism)

- Gateway သည် စတင်ချိန်တွင် ချက်ချင်း WebSocket listener (ပုံမှန် `ws://127.0.0.1:18789`) ကို သီးသန့် TCP listener ဖြင့် bind လုပ်သည်။
- bind လုပ်ရာတွင် `EADDRINUSE` ဖြင့် မအောင်မြင်ပါက startup သည် `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")` ကို ပစ်ချသည်။
- OS သည် process အဆုံးသတ်သည့်အချိန်တိုင်း (crash များနှင့် SIGKILL အပါအဝင်) listener ကို အလိုအလျောက် လွှတ်ပေးသည်—သီးခြား lock ဖိုင် သို့မဟုတ် cleanup အဆင့် မလိုအပ်ပါ။
- ပိတ်ချိန်တွင် Gateway သည် WebSocket server နှင့် အောက်ခံ HTTP server ကို ပိတ်ပြီး port ကို အမြန်လွှတ်ပေးသည်။

## အမှားပြသမှု (Error surface)

- အခြား process တစ်ခုက port ကို ကိုင်ထားပါက startup သည် `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")` ကို ပစ်ချသည်။
- အခြား bind မအောင်မြင်မှုများကို `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")` အဖြစ် ပြသသည်။

## လည်ပတ်ရေးဆိုင်ရာ မှတ်ချက်များ

- port ကို _အခြား_ process တစ်ခုက အသုံးပြုနေပါက အမှားသည် တူညီနေမည်ဖြစ်သည်; port ကို လွှတ်ပေးရန် သို့မဟုတ် `openclaw gateway --port <port>` ဖြင့် အခြား port ကို ရွေးချယ်ပါ။
- macOS app သည် Gateway ကို စတင်ဖွင့်မီ ကိုယ်ပိုင် လွယ်ကူသော PID guard ကို ထိန်းသိမ်းထားသော်လည်း runtime lock ကို WebSocket bind ဖြင့်သာ အတည်ပြုအကောင်အထည်ဖော်ထားသည်။
