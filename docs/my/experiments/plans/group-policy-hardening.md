---
summary: "Telegram allowlist ကို ခိုင်မာစေခြင်း: prefix + whitespace ကို စံညွှန်းတကျ ပြုပြင်ခြင်း"
read_when:
  - Telegram allowlist ပြောင်းလဲမှုများ၏ သမိုင်းကို ပြန်လည်သုံးသပ်နေစဉ်
title: "Telegram Allowlist ကို ခိုင်မာစေခြင်း"
---

# Telegram Allowlist ကို ခိုင်မာစေခြင်း

**Date**: 2026-01-05  
**Status**: Complete  
**PR**: #216

## Summary

ဤအရာသည် outbound send normalization နှင့် inbound allowlist checks များကို ကိုက်ညီစေပါသည်။ Logs သို့မဟုတ် chat IDs များမှ copy/paste လုပ်ရာတွင် prefixes နှင့် whitespace များ ပါဝင်လာတတ်ပါသည်။

## What changed

- `telegram:` နှင့် `tg:` prefix များကို အတူတူအဖြစ် (အကြီးအသေးမခွဲဘဲ) ဆက်ဆံသည်။
- Allowlist အတွင်းရှိ entry များကို အနား whitespace များ ဖယ်ရှားပြီး၊ အလွတ် entry များကို လျစ်လျူရှုသည်။

## Examples

အောက်ပါအရာအားလုံးကို ID တစ်ခုတည်းအတွက် လက်ခံသည်—

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Why it matters

Normalization ပြုလုပ်ခြင်းသည် DMs သို့မဟုတ် groups များတွင် ပြန်ကြားရမလား ဆုံးဖြတ်ရာတွင် false negatives များကို ရှောင်ရှားပေးပါသည်။ Open Responses သည် OpenAI Responses API အပေါ် အခြေခံထားသော open inference standard တစ်ခု ဖြစ်ပါသည်။

## Related docs

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
