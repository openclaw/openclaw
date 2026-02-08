---
summary: "အေးဂျင့်၏ အလုပ်ခန်း (workspace) နှင့် အိုင်ဒင်တီတီ ဖိုင်များကို စတင်ပျိုးထောင်ပေးသော bootstrapping လုပ်ငန်းစဉ်"
read_when:
  - အေးဂျင့်ကို ပထမဆုံး အလုပ်လုပ်စဉ် ဘာတွေ ဖြစ်ပေါ်လာသလဲကို နားလည်ရန်
  - bootstrapping ဖိုင်များ ဘယ်နေရာမှာ ရှိနေသလဲကို ရှင်းပြရန်
  - onboarding အိုင်ဒင်တီတီ တပ်ဆင်မှုကို ပြဿနာရှာဖွေရန်
title: "အေးဂျင့် Bootstrapping"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:58Z
---

# အေးဂျင့် Bootstrapping

Bootstrapping သည် **ပထမဆုံး အလုပ်လုပ်စဉ်** အတွင်း အေးဂျင့်၏ အလုပ်ခန်း (workspace) ကို ပြင်ဆင်ပြီး
အိုင်ဒင်တီတီ အသေးစိတ်အချက်အလက်များကို စုဆောင်းပေးသော လုပ်ငန်းစဉ်ဖြစ်သည်။ ၎င်းသည် onboarding ပြီးဆုံးပြီးနောက်
အေးဂျင့်ကို ပထမဆုံး စတင်အလုပ်လုပ်ချိန်တွင် ဖြစ်ပေါ်လာသည်။

## Bootstrapping က ဘာလုပ်သလဲ

အေးဂျင့်ကို ပထမဆုံး အလုပ်လုပ်ချိန်တွင် OpenClaw သည် အလုပ်ခန်းကို bootstrapping ပြုလုပ်သည် (မူလတန်ဖိုး
`~/.openclaw/workspace`) ဖြစ်သည်။

- `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md` ကို မျိုးစေ့ချ ပေါင်းထည့်သည်။
- မေးခွန်း–အဖြေ လုပ်ငန်းစဉ်တို (တစ်ကြိမ်လျှင် မေးခွန်းတစ်ခုစီ) ကို လုပ်ဆောင်သည်။
- အိုင်ဒင်တီတီ နှင့် နှစ်သက်မှုများကို `IDENTITY.md`, `USER.md`, `SOUL.md` ထဲသို့ ရေးသားသည်။
- တစ်ကြိမ်သာ လုပ်ဆောင်စေရန် ပြီးဆုံးသွားပါက `BOOTSTRAP.md` ကို ဖယ်ရှားသည်။

## ဘယ်နေရာမှာ လုပ်ဆောင်သလဲ

Bootstrapping သည် အမြဲတမ်း **Gateway ဟို့စ်** ပေါ်တွင် လုပ်ဆောင်သည်။ macOS အက်ပ်က
အဝေးရှိ Gateway（ဂိတ်ဝေး） သို့ ချိတ်ဆက်ထားပါက အလုပ်ခန်းနှင့် bootstrapping ဖိုင်များသည်
အဲဒီအဝေးရှိ စက်ပေါ်တွင် တည်ရှိနေမည်ဖြစ်သည်။

<Note>
Gateway（ဂိတ်ဝေး） သည် အခြားစက်တစ်လုံးပေါ်တွင် လည်ပတ်နေပါက အလုပ်ခန်းဖိုင်များကို gateway ဟို့စ် ပေါ်တွင်သာ
တည်းဖြတ်ပါ (ဥပမာ၊ `user@gateway-host:~/.openclaw/workspace`)။
</Note>

## ဆက်စပ် စာရွက်စာတမ်းများ

- macOS အက်ပ် onboarding: [Onboarding](/start/onboarding)
- အလုပ်ခန်း အပြင်အဆင်: [Agent workspace](/concepts/agent-workspace)
