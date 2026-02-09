---
summary: "အေးဂျင့်၏ အလုပ်ခန်း (workspace) နှင့် အိုင်ဒင်တီတီ ဖိုင်များကို စတင်ပျိုးထောင်ပေးသော bootstrapping လုပ်ငန်းစဉ်"
read_when:
  - အေးဂျင့်ကို ပထမဆုံး အလုပ်လုပ်စဉ် ဘာတွေ ဖြစ်ပေါ်လာသလဲကို နားလည်ရန်
  - bootstrapping ဖိုင်များ ဘယ်နေရာမှာ ရှိနေသလဲကို ရှင်းပြရန်
  - onboarding အိုင်ဒင်တီတီ တပ်ဆင်မှုကို ပြဿနာရှာဖွေရန်
title: "အေးဂျင့် Bootstrapping"
sidebarTitle: "Bootstrapping"
---

# အေးဂျင့် Bootstrapping

Bootstrapping is the **first‑run** ritual that prepares an agent workspace and
collects identity details. It happens after onboarding, when the agent starts
for the first time.

## Bootstrapping က ဘာလုပ်သလဲ

အေးဂျင့်ကို ပထမဆုံး အလုပ်လုပ်ချိန်တွင် OpenClaw သည် အလုပ်ခန်းကို bootstrapping ပြုလုပ်သည် (မူလတန်ဖိုး
`~/.openclaw/workspace`) ဖြစ်သည်။

- `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md` ကို မျိုးစေ့ချ ပေါင်းထည့်သည်။
- မေးခွန်း–အဖြေ လုပ်ငန်းစဉ်တို (တစ်ကြိမ်လျှင် မေးခွန်းတစ်ခုစီ) ကို လုပ်ဆောင်သည်။
- အိုင်ဒင်တီတီ နှင့် နှစ်သက်မှုများကို `IDENTITY.md`, `USER.md`, `SOUL.md` ထဲသို့ ရေးသားသည်။
- တစ်ကြိမ်သာ လုပ်ဆောင်စေရန် ပြီးဆုံးသွားပါက `BOOTSTRAP.md` ကို ဖယ်ရှားသည်။

## ဘယ်နေရာမှာ လုပ်ဆောင်သလဲ

Bootstrapping always runs on the **gateway host**. If the macOS app connects to
a remote Gateway, the workspace and bootstrapping files live on that remote
machine.

<Note>
Gateway（ဂိတ်ဝေး） သည် အခြားစက်တစ်လုံးပေါ်တွင် လည်ပတ်နေပါက အလုပ်ခန်းဖိုင်များကို gateway ဟို့စ် ပေါ်တွင်သာ
တည်းဖြတ်ပါ (ဥပမာ၊ `user@gateway-host:~/.openclaw/workspace`)။
</Note>

## ဆက်စပ် စာရွက်စာတမ်းများ

- macOS အက်ပ် onboarding: [Onboarding](/start/onboarding)
- အလုပ်ခန်း အပြင်အဆင်: [Agent workspace](/concepts/agent-workspace)
