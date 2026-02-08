---
summary: "Gateway၊ နိုဒ်များနှင့် canvas host တို့ မည်သို့ ချိတ်ဆက်အလုပ်လုပ်ကြသည်ကို ဖော်ပြထားသည်။"
read_when:
  - Gateway ကွန်ယက်မော်ဒယ်ကို အကျဉ်းချုပ်အနေနှင့် သိလိုပါက
title: "ကွန်ယက် မော်ဒယ်"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:20Z
---

အလုပ်လုပ်ဆောင်မှုအများစုသည် Gateway (`openclaw gateway`) မှတစ်ဆင့် စီးဆင်းသွားပါသည်။ ၎င်းသည် ချန်နယ်ချိတ်ဆက်မှုများနှင့် WebSocket ထိန်းချုပ်ရေးအလွှာကို ပိုင်ဆိုင်ထားသော အချိန်ကြာကြာ လည်ပတ်နေသည့် လုပ်ငန်းစဉ်တစ်ခု ဖြစ်ပါသည်။

## အဓိက စည်းမျဉ်းများ

- ဟို့စ်တစ်ခုလျှင် Gateway တစ်ခုသာ အသုံးပြုရန် အကြံပြုပါသည်။ ၎င်းသည် WhatsApp Web ဆက်ရှင်ကို ပိုင်ဆိုင်ခွင့်ရှိသော လုပ်ငန်းစဉ်တစ်ခုတည်း ဖြစ်ပါသည်။ ကယ်ဆယ်ရေး ဘော့များ သို့မဟုတ် ခွဲခြားသီးသန့်မှုကို တင်းကျပ်စွာ လိုအပ်ပါက ပရိုဖိုင်နှင့် ပို့တ်များကို သီးခြားထားပြီး Gateway များစွာကို လည်ပတ်စေနိုင်ပါသည်။ [Multiple gateways](/gateway/multiple-gateways) ကို ကြည့်ပါ။
- Loopback ကို ဦးစားပေးပါ– Gateway WS ၏ မူလသတ်မှတ်ချက်မှာ `ws://127.0.0.1:18789` ဖြစ်ပါသည်။ wizard သည် loopback အတွက်တောင် မူလအနေဖြင့် gateway token တစ်ခုကို ဖန်တီးပေးပါသည်။ tailnet မှ ဝင်ရောက်အသုံးပြုရန်အတွက် loopback မဟုတ်သော bind များတွင် token များ လိုအပ်သောကြောင့် `openclaw gateway --bind tailnet --token ...` ကို လည်ပတ်ပါ။
- နိုဒ်များသည် လိုအပ်သလို LAN၊ tailnet သို့မဟုတ် SSH မှတစ်ဆင့် Gateway WS သို့ ချိတ်ဆက်ပါသည်။ အဟောင်းဖြစ်သွားသော TCP bridge ကို မထောက်ခံတော့ပါ။
- Canvas host သည် `canvasHost.port` (မူလ `18793`) ပေါ်တွင် လည်ပတ်သော HTTP ဖိုင်ဆာဗာတစ်ခုဖြစ်ပြီး နိုဒ် WebViews များအတွက် `/__openclaw__/canvas/` ကို ပံ့ပိုးပေးပါသည်။ [Gateway configuration](/gateway/configuration) (`canvasHost`) ကို ကြည့်ပါ။
- အဝေးမှ အသုံးပြုမှုတွင် အများအားဖြင့် SSH တန်နယ် သို့မဟုတ် tailnet VPN ကို အသုံးပြုပါသည်။ [Remote access](/gateway/remote) နှင့် [Discovery](/gateway/discovery) ကို ကြည့်ပါ။
