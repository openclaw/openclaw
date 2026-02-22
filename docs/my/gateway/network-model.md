---
summary: "Gateway၊ နိုဒ်များနှင့် canvas host တို့ မည်သို့ ချိတ်ဆက်အလုပ်လုပ်ကြသည်ကို ဖော်ပြထားသည်။"
read_when:
  - Gateway ကွန်ယက်မော်ဒယ်ကို အကျဉ်းချုပ်အနေနှင့် သိလိုပါက
title: "ကွန်ယက် မော်ဒယ်"
---

အလုပ်လုပ်ဆောင်မှုအများစုသည် Gateway (`openclaw gateway`) မှတစ်ဆင့် စီးဆင်းသွားပါသည်။ ၎င်းသည် ချန်နယ်ချိတ်ဆက်မှုများနှင့် WebSocket ထိန်းချုပ်ရေးအလွှာကို ပိုင်ဆိုင်ထားသော အချိန်ကြာကြာ လည်ပတ်နေသည့် လုပ်ငန်းစဉ်တစ်ခု ဖြစ်ပါသည်။

## အဓိက စည်းမျဉ်းများ

- Host တစ်ခုလျှင် Gateway တစ်ခုသာ အသုံးပြုရန် အကြံပြုသည်။ WhatsApp Web session ကို ကိုင်ဆောင်ခွင့် ရှိသည့် process တစ်ခုတည်းမှာ ယင်းဖြစ်သည်။ Rescue bot များ သို့မဟုတ် တင်းကျပ်သော isolation အတွက် isolated profile နှင့် port များဖြင့် gateway များစွာကို လည်ပတ်ပါ။ [Multiple gateways](/gateway/multiple-gateways) ကို ကြည့်ပါ။
- Loopback ကို ဦးစားပေးပါ: Gateway WS ၏ မူလသတ်မှတ်ချက်မှာ `ws://127.0.0.1:18789` ဖြစ်သည်။ Wizard သည် loopback အတွက်တောင် gateway token ကို မူလအနေဖြင့် ဖန်တီးပေးသည်။ Tailnet access အတွက် token များသည် non-loopback bind များတွင် မဖြစ်မနေ လိုအပ်သောကြောင့် `openclaw gateway --bind tailnet --token ...` ကို လည်ပတ်ပါ။
- Node များသည် လိုအပ်သလို LAN၊ tailnet သို့မဟုတ် SSH မှတစ်ဆင့် Gateway WS သို့ ချိတ်ဆက်သည်။ Legacy TCP bridge ကို မထောက်ပံ့တော့ပါ (deprecated)။
- Canvas host သည် `canvasHost.port` (ပုံမှန် `18793`) တွင် `/__openclaw__/canvas/` ကို node WebViews အတွက် ပေးဆောင်သော HTTP file server ဖြစ်သည်။ [Gateway configuration](/gateway/configuration) (`canvasHost`) ကို ကြည့်ပါ။
- Remote အသုံးပြုမှုအတွက် ပုံမှန်အားဖြင့် SSH tunnel သို့မဟုတ် tailnet VPN ကို အသုံးပြုသည်။ [Remote access](/gateway/remote) နှင့် [Discovery](/gateway/discovery) ကို ကြည့်ပါ။
