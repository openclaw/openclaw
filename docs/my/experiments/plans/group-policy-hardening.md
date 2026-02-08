---
summary: "Telegram allowlist ကို ခိုင်မာစေခြင်း: prefix + whitespace ကို စံညွှန်းတကျ ပြုပြင်ခြင်း"
read_when:
  - "Telegram allowlist ပြောင်းလဲမှုများ၏ သမိုင်းကို ပြန်လည်သုံးသပ်နေစဉ်"
title: "Telegram Allowlist ကို ခိုင်မာစေခြင်း"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:13Z
---

# Telegram Allowlist ကို ခိုင်မာစေခြင်း

**Date**: 2026-01-05  
**Status**: Complete  
**PR**: #216

## Summary

Telegram allowlists များသည် ယခုအခါ `telegram:` နှင့် `tg:` prefix များကို အကြီးအသေးမခွဲဘဲ လက်ခံနိုင်ပြီး၊
မတော်တဆ ပါဝင်လာသည့် whitespace များကိုလည်း သက်သာစွာ လက်ခံနိုင်သည်။ ၎င်းသည် အပြင်သို့ ပို့ရာတွင် ပြုလုပ်သော
send normalization နှင့် အဝင် allowlist စစ်ဆေးမှုများကို ကိုက်ညီစေသည်။

## What changed

- `telegram:` နှင့် `tg:` prefix များကို အတူတူအဖြစ် (အကြီးအသေးမခွဲဘဲ) ဆက်ဆံသည်။
- Allowlist အတွင်းရှိ entry များကို အနား whitespace များ ဖယ်ရှားပြီး၊ အလွတ် entry များကို လျစ်လျူရှုသည်။

## Examples

အောက်ပါအရာအားလုံးကို ID တစ်ခုတည်းအတွက် လက်ခံသည်—

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Why it matters

Logs သို့မဟုတ် chat ID များမှ copy/paste လုပ်ရာတွင် prefix များနှင့် whitespace များ ပါဝင်လာတတ်သည်။
Normalization ပြုလုပ်ခြင်းဖြင့် DM မက်ဆေ့ချ်များ သို့မဟုတ် အုပ်စုများတွင် တုံ့ပြန်မလား ဆုံးဖြတ်ရာတွင်
မှားယွင်းသော negative များ ဖြစ်ပေါ်ခြင်းကို ရှောင်ရှားနိုင်သည်။

## Related docs

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
