---
summary: "ပစ်မှတ်ထားသော ဒီဘက်ဂ် လော့ဂ်များအတွက် Diagnostics အလံများ"
read_when:
  - အထွေထွေ လော့ဂ်အဆင့်များကို မြှင့်တင်ခြင်းမလုပ်ဘဲ ပစ်မှတ်ထားသော ဒီဘက်ဂ် လော့ဂ်များ လိုအပ်သည့်အခါ
  - အထောက်အပံ့အတွက် subsystem အလိုက် လော့ဂ်များကို ဖမ်းယူရန် လိုအပ်သည့်အခါ
title: "Diagnostics အလံများ"
x-i18n:
  source_path: diagnostics/flags.md
  source_hash: daf0eca0e6bd1cbc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:17Z
---

# Diagnostics အလံများ

Diagnostics အလံများသည် နေရာအနှံ့ verbose logging ကို ဖွင့်စရာမလိုဘဲ ပစ်မှတ်ထားသော ဒီဘက်ဂ် လော့ဂ်များကို ဖွင့်နိုင်စေပါသည်။ အလံများသည် opt-in ဖြစ်ပြီး subsystem တစ်ခုက စစ်ဆေးအသုံးပြုမှသာ သက်ရောက်မှုရှိပါသည်။

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

အလံများမှ ထုတ်လွှတ်သော လော့ဂ်များကို စံသတ်မှတ် diagnostics လော့ဂ် ဖိုင်ထဲသို့ ထည့်သွင်းပါသည်။ မူလအနေဖြင့်—

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` ကို သတ်မှတ်ထားပါက ထိုလမ်းကြောင်းကို အသုံးပြုပါမည်။ လော့ဂ်များသည် JSONL (တစ်ကြောင်းလျှင် JSON အရာဝတ္ထုတစ်ခု) ဖြစ်သည်။ `logging.redactSensitive` အပေါ်မူတည်၍ Redaction သည် ဆက်လက် သက်ရောက်နေပါသည်။

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

- `logging.level` သည် `warn` ထက် မြင့်မားနေပါက ဤလော့ဂ်များကို ဖိနှိပ်ထားနိုင်ပါသည်။ မူလ `info` သည် သင့်တော်ပါသည်။
- အလံများကို ဖွင့်ထားထားသည့်အတိုင်း လုံခြုံပါသည်; သက်ဆိုင်ရာ subsystem အတွက် လော့ဂ်ပမာဏကိုသာ သက်ရောက်စေပါသည်။
- လော့ဂ် သွားရာနေရာများ၊ အဆင့်များနှင့် redaction ကို ပြောင်းလဲရန် [/logging](/logging) ကို အသုံးပြုပါ။
