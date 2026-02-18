---
summary: "အဝင် ချန်နယ် တည်နေရာ ခွဲခြမ်းစိတ်ဖြာခြင်း (Telegram + WhatsApp) နှင့် context အကွက်များ"
read_when:
  - ချန်နယ် တည်နေရာ ခွဲခြမ်းစိတ်ဖြာမှုကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း ပြုလုပ်သည့်အခါ
  - agent prompt များ သို့မဟုတ် tool များတွင် တည်နေရာ context အကွက်များကို အသုံးပြုသည့်အခါ
title: "ချန်နယ် တည်နေရာ ခွဲခြမ်းစိတ်ဖြာခြင်း"
---

# ချန်နယ် တည်နေရာ ခွဲခြမ်းစိတ်ဖြာခြင်း

OpenClaw သည် ချတ် ချန်နယ်များမှ မျှဝေထားသော တည်နေရာများကို အောက်ပါအတိုင်း စံပြုလုပ်ထားပါသည်—

- လူဖတ်လို့လွယ်ကူသော စာသားကို အဝင် body အဆုံးတွင် ထည့်သွင်းခြင်း၊ နှင့်
- အလိုအလျောက် ပြန်ကြားချက် context payload အတွင်းရှိ ဖွဲ့စည်းထားသော အကွက်များ။

လက်ရှိ ပံ့ပိုးထားသော ချန်နယ်များ—

- **Telegram** (location pin များ + venue များ + live location များ)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` with `geo_uri`)

## စာသား ဖော်မတ်ချခြင်း

တည်နေရာများကို ကွင်းစကွင်းပိတ် မပါဘဲ မိတ်ဆွေလိုက်ဖက်သော လိုင်းများအဖြစ် ပြသပါသည်—

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- အမည်ပါသော နေရာ:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Live share:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

ချန်နယ်တွင် caption/comment ပါရှိပါက နောက်တစ်လိုင်းတွင် ဆက်လက် ထည့်သွင်းပါသည်—

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Context အကွက်များ

တည်နေရာ ပါရှိသည့်အခါ `ctx` ထဲသို့ အောက်ပါ အကွက်များကို ထည့်သွင်းပါသည်—

- `LocationLat` (number)
- `LocationLon` (number)
- `LocationAccuracy` (number, meters; optional)
- `LocationName` (string; optional)
- `LocationAddress` (string; optional)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)

## ချန်နယ် အကြောင်းမှတ်ချက်များ

- **Telegram**: venue များကို `LocationName/LocationAddress` သို့ mapping လုပ်ထားပြီး; live location များသည် `live_period` ကို အသုံးပြုပါသည်။
- **WhatsApp**: `locationMessage.comment` နှင့် `liveLocationMessage.caption` ကို caption လိုင်းအဖြစ် ဆက်လက် ထည့်သွင်းပါသည်။
- **Matrix**: `geo_uri` ကို pin တည်နေရာအဖြစ် ခွဲခြမ်းစိတ်ဖြာပါသည်; altitude ကို လျစ်လျူရှုထားပြီး `LocationIsLive` သည် အမြဲတမ်း false ဖြစ်ပါသည်။
