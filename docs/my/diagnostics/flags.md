---
summary: "ပစ်မှတ်ထားသော ဒီဘက်ဂ် လော့ဂ်များအတွက် Diagnostics အလံများ"
read_when:
  - အထွေထွေ လော့ဂ်အဆင့်များကို မြှင့်တင်ခြင်းမလုပ်ဘဲ ပစ်မှတ်ထားသော ဒီဘက်ဂ် လော့ဂ်များ လိုအပ်သည့်အခါ
  - အထောက်အပံ့အတွက် subsystem အလိုက် လော့ဂ်များကို ဖမ်းယူရန် လိုအပ်သည့်အခါ
title: "Diagnostics အလံများ"
---

# Diagnostics အလံများ

Diagnostics flags များကို အသုံးပြုခြင်းဖြင့် နေရာအလိုက် debug logs များကို ဖွင့်နိုင်ပြီး နေရာတိုင်းတွင် verbose logging ကို မဖွင့်ရပါ။ Flags များသည် opt-in ဖြစ်ပြီး subsystem တစ်ခုက မစစ်ဆေးပါက မည်သည့် အကျိုးသက်ရောက်မှုမှ မရှိပါ။

## အလုပ်လုပ်ပုံ

- အလံများသည် စာကြောင်းများ (case-insensitive) ဖြစ်သည်။
- config ထဲတွင် သို့မဟုတ် env override ဖြင့် အလံများကို ဖွင့်နိုင်သည်။
- Wildcard များကို ပံ့ပိုးထားသည်—
  - `telegram.*` သည် `telegram.http` ကို ကိုက်ညီစေသည်
  - `*` သည် အလံအားလုံးကို ဖွင့်ပေးသည်

## config ဖြင့် ဖွင့်ခြင်း

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

အလံများ အများအပြား—

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

အလံများကို ပြောင်းလဲပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

## Env override (တစ်ကြိမ်သုံး)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

အလံအားလုံးကို ပိတ်ရန်—

```bash
OPENCLAW_DIAGNOSTICS=0
```

## လော့ဂ်များ သွားရာနေရာ

Flags များသည် standard diagnostics log ဖိုင်ထဲသို့ logs များကို ထုတ်လွှတ်ပါသည်။ မူလအားဖြင့်:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` ကို သတ်မှတ်ထားပါက၊ ထို path ကို အသုံးပြုပါ။ Logs များသည် JSONL ဖြစ်သည် (လိုင်းတစ်လိုင်းလျှင် JSON object တစ်ခု)။ `logging.redactSensitive` အပေါ် မူတည်၍ Redaction သည် ဆက်လက် သက်ရောက်ပါသည်။

## လော့ဂ်များ ထုတ်ယူခြင်း

နောက်ဆုံး လော့ဂ် ဖိုင်ကို ရွေးပါ—

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP diagnostics အတွက် စစ်ထုတ်ရန်—

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

သို့မဟုတ် ပြန်လည်ဖြစ်ပေါ်အောင် လုပ်နေစဉ် tail လုပ်ရန်—

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

အဝေးမှ Gateway များအတွက် `openclaw logs --follow` ကိုလည်း အသုံးပြုနိုင်သည် ( [/cli/logs](/cli/logs) ကို ကြည့်ပါ)။

## မှတ်ချက်များ

- `logging.level` ကို `warn` ထက် မြင့်အောင် သတ်မှတ်ထားပါက၊ ဤ logs များကို ဖိနှိပ်ထားနိုင်ပါသည်။ မူလ `info` သည် လုံလောက်ပါသည်။
- အလံများကို ဖွင့်ထားထားသည့်အတိုင်း လုံခြုံပါသည်; သက်ဆိုင်ရာ subsystem အတွက် လော့ဂ်ပမာဏကိုသာ သက်ရောက်စေပါသည်။
- လော့ဂ် သွားရာနေရာများ၊ အဆင့်များနှင့် redaction ကို ပြောင်းလဲရန် [/logging](/logging) ကို အသုံးပြုပါ။
