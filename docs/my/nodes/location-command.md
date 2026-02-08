---
summary: "နိုဒ်များအတွက် Location အမိန့် (location.get)၊ ခွင့်ပြုချက် မုဒ်များနှင့် နောက်ခံ အပြုအမူ"
read_when:
  - Location နိုဒ် အထောက်အပံ့ သို့မဟုတ် ခွင့်ပြုချက် UI ကို ထည့်သွင်းရာတွင်
  - နောက်ခံ Location + push လုပ်ငန်းစဉ်များကို ဒီဇိုင်းရေးဆွဲရာတွင်
title: "Location အမိန့်"
x-i18n:
  source_path: nodes/location-command.md
  source_hash: 23124096256384d2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:42Z
---

# Location အမိန့် (နိုဒ်များ)

## TL;DR

- `location.get` သည် နိုဒ် အမိန့်တစ်ခု ဖြစ်သည် (`node.invoke` မှတစ်ဆင့်)။
- မူလအနေဖြင့် ပိတ်ထားသည်။
- ဆက်တင်များတွင် ရွေးချယ်ကိရိယာကို အသုံးပြုသည်: Off / While Using / Always။
- သီးခြား toggle: Precise Location။

## Selector ကို အသုံးပြုရသည့် အကြောင်းရင်း (switch တစ်ခုတည်း မဟုတ်ခြင်း)

OS ခွင့်ပြုချက်များမှာ အဆင့်အတန်းများ ပါဝင်သည်။ အက်ပ်အတွင်း Selector ကို ဖော်ပြနိုင်သော်လည်း အမှန်တကယ် ခွင့်ပြုချက် ပေးခြင်းကို OS က ဆုံးဖြတ်သည်။

- iOS/macOS: စနစ် prompt များ/Settings တွင် **While Using** သို့မဟုတ် **Always** ကို အသုံးပြုသူက ရွေးချယ်နိုင်သည်။ အက်ပ်မှ အဆင့်မြှင့်တင်ရန် တောင်းဆိုနိုင်သော်လည်း OS က Settings သို့ သွားရန် လိုအပ်စေတတ်သည်။
- Android: နောက်ခံ Location သည် သီးခြား ခွင့်ပြုချက်တစ်ခု ဖြစ်သည်; Android 10+ တွင် Settings လုပ်ငန်းစဉ် လိုအပ်တတ်သည်။
- Precise location သည် သီးခြား ခွင့်ပြုချက်တစ်ခု ဖြစ်သည် (iOS 14+ “Precise”, Android “fine” နှင့် “coarse” ခြားနားမှု)။

UI အတွင်း Selector သည် ကျွန်ုပ်တို့ တောင်းဆိုမည့် မုဒ်ကို ညွှန်ပြပေးပြီး အမှန်တကယ် ခွင့်ပြုချက်သည် OS Settings ထဲတွင် တည်ရှိသည်။

## Settings မော်ဒယ်

နိုဒ် စက်တစ်ခုချင်းစီအလိုက်:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI အပြုအမူ:

- `whileUsing` ကို ရွေးချယ်ပါက foreground ခွင့်ပြုချက်ကို တောင်းဆိုသည်။
- `always` ကို ရွေးချယ်ပါက `whileUsing` ကို ဦးစွာ သေချာစေပြီး၊ ထို့နောက် နောက်ခံ ခွင့်ပြုချက်ကို တောင်းဆိုသည် (လိုအပ်ပါက အသုံးပြုသူကို Settings သို့ ပို့သည်)။
- OS က တောင်းဆိုထားသော အဆင့်ကို ငြင်းပယ်ပါက၊ ခွင့်ပြုထားသည့် အမြင့်ဆုံး အဆင့်သို့ ပြန်လည်သတ်မှတ်ပြီး အခြေအနေကို ပြသသည်။

## Permissions mapping (node.permissions)

မဖြစ်မနေ မလိုအပ်ပါ။ macOS နိုဒ်သည် permissions map မှတစ်ဆင့် `location` ကို အစီရင်ခံပါသည်; iOS/Android တွင် မပါဝင်နိုင်ပါ။

## Command: `location.get`

`node.invoke` မှတစ်ဆင့် ခေါ်ယူသည်။

Params (အကြံပြု):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Response payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Errors (တည်ငြိမ်သော ကုဒ်များ):

- `LOCATION_DISABLED`: selector ပိတ်ထားသည်။
- `LOCATION_PERMISSION_REQUIRED`: တောင်းဆိုထားသော မုဒ်အတွက် ခွင့်ပြုချက် မရှိပါ။
- `LOCATION_BACKGROUND_UNAVAILABLE`: အက်ပ်သည် နောက်ခံတွင် ရှိနေပြီး While Using သာ ခွင့်ပြုထားသည်။
- `LOCATION_TIMEOUT`: သတ်မှတ်ချိန်အတွင်း fix မရပါ။
- `LOCATION_UNAVAILABLE`: စနစ် ချို့ယွင်းမှု / ပံ့ပိုးသူ မရှိပါ။

## နောက်ခံ အပြုအမူ (အနာဂတ်)

ရည်မှန်းချက်: နိုဒ်သည် နောက်ခံတွင် ရှိနေသည့်အချိန်တွင်ပါ မော်ဒယ်က Location ကို တောင်းဆိုနိုင်ရန် — အောက်ပါ အခြေအနေများ ပြည့်မီရပါမည်။

- အသုံးပြုသူက **Always** ကို ရွေးချယ်ထားသည်။
- OS က နောက်ခံ Location ကို ခွင့်ပြုထားသည်။
- အက်ပ်ကို Location အတွက် နောက်ခံတွင် လည်ပတ်ခွင့် ပေးထားသည် (iOS background mode / Android foreground service သို့မဟုတ် အထူး ခွင့်ပြုချက်)။

Push ဖြင့် အစပြုသော လုပ်ငန်းစဉ် (အနာဂတ်):

1. Gateway（ဂိတ်ဝေး） က နိုဒ်သို့ push တစ်ခု ပို့သည် (silent push သို့မဟုတ် FCM data)။
2. နိုဒ်သည် ခဏတာ နိုးထပြီး စက်မှ Location ကို တောင်းဆိုသည်။
3. နိုဒ်က payload ကို Gateway（ဂိတ်ဝေး） သို့ ပြန်လည်ပို့သည်။

မှတ်ချက်များ:

- iOS: Always ခွင့်ပြုချက် + နောက်ခံ Location mode လိုအပ်သည်။ Silent push ကို ကန့်သတ်နိုင်ပြီး မကြာခဏ မအောင်မြင်မှုများ ဖြစ်နိုင်သည်။
- Android: နောက်ခံ Location အတွက် foreground service လိုအပ်နိုင်သည်; မဟုတ်ပါက ငြင်းပယ်ခံရနိုင်သည်။

## မော်ဒယ်/ကိရိယာ ပေါင်းစည်းမှု

- Tool surface: `nodes` tool သည် `location_get` action ကို ထည့်သွင်းပေးသည် (နိုဒ် လိုအပ်)။
- CLI: `openclaw nodes location get --node <id>`။
- Agent လမ်းညွှန်ချက်များ: အသုံးပြုသူက Location ကို ဖွင့်ထားပြီး အကျယ်အဝန်းကို နားလည်ထားသောအခါတွင်သာ ခေါ်ယူရန်။

## UX စာသား (အကြံပြု)

- Off: “Location မျှဝေမှုကို ပိတ်ထားသည်။”
- While Using: “OpenClaw ဖွင့်ထားချိန်တွင်သာ။”
- Always: “နောက်ခံ Location ကို ခွင့်ပြုပါ။ စနစ် ခွင့်ပြုချက် လိုအပ်သည်။”
- Precise: “တိကျသော GPS Location ကို အသုံးပြုပါ။ ပိတ်ထားပါက ခန့်မှန်း Location ကို မျှဝေပါမည်။”
