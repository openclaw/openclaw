---
summary: "SOUL Evil ဟုခ် (SOUL.md ကို SOUL_EVIL.md နှင့် လဲလှယ်ခြင်း)"
read_when:
  - SOUL Evil ဟုခ်ကို ဖွင့်ရန် သို့မဟုတ် ချိန်ညှိရန် လိုအပ်သောအခါ
  - purge window သို့မဟုတ် ကျပန်းအခွင့်အလမ်းဖြင့် persona လဲလှယ်ခြင်းကို လိုအပ်သောအခါ
title: "SOUL Evil Hook"
---

# SOUL Evil Hook

SOUL Evil hook သည် **ထည့်သွင်းထားသော** `SOUL.md` အကြောင်းအရာကို purge window အတွင်း သို့မဟုတ် ကျပန်းအခါအားဖြင့် `SOUL_EVIL.md` နှင့် အစားထိုးပါသည်။ ၎င်းသည် disk ပေါ်ရှိ ဖိုင်များကို **မပြုပြင်ပါ**။

## အလုပ်လုပ်ပုံ

`agent:bootstrap` chạy လိုက်တဲ့အခါ hook က system prompt ကို တည်ဆောက်မလုပ်မီ `SOUL.md` အကြောင်းအရာကို memory ထဲမှာ အစားထိုးနိုင်ပါတယ်။ `SOUL_EVIL.md` မရှိပါက သို့မဟုတ် အလွတ်ဖြစ်နေပါက၊ OpenClaw သည် သတိပေးချက်ကို log လုပ်ပြီး ပုံမှန် `SOUL.md` ကို ဆက်လက်အသုံးပြုပါသည်။

Sub-agent လည်ပတ်မှုများတွင် `SOUL.md` ကို ၎င်းတို့၏ bootstrap ဖိုင်များတွင် မပါဝင်သဖြင့် ဤဟုခ်သည် sub-agent များအပေါ် အကျိုးသက်ရောက်မှု မရှိပါ။

## ဖွင့်ရန်

```bash
openclaw hooks enable soul-evil
```

ထို့နောက် config ကို သတ်မှတ်ပါ—

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

အေးဂျင့် workspace root ( `SOUL.md` ၏ ဘေးတွင်) တွင် `SOUL_EVIL.md` ကို ဖန်တီးပါ။

## ရွေးချယ်စရာများ

- `file` (string): အစားထိုး SOUL ဖိုင်အမည် (မူလတန်ဖိုး: `SOUL_EVIL.md`)
- `chance` (number 0–1): လည်ပတ်မှုတစ်ကြိမ်စီအတွက် `SOUL_EVIL.md` ကို အသုံးပြုမည့် ကျပန်းအခွင့်အလမ်း
- `purge.at` (HH:mm): နေ့စဉ် purge စတင်ချိန် (၂၄ နာရီ စနစ်)
- `purge.duration` (duration): window အရှည် (ဥပမာ `30s`, `10m`, `1h`)

**အရေးပေါ်ဦးစားပေးမှု:** purge window သည် chance ထက် ဦးစားပေးပါသည်။

**အချိန်ဇုန်:** သတ်မှတ်ထားပါက `agents.defaults.userTimezone` ကို အသုံးပြုပါသည်။ မရှိပါက ဟို့စ်၏ အချိန်ဇုန်ကို အသုံးပြုပါသည်။

## မှတ်ချက်များ

- ဒစ်စ်ပေါ်ရှိ ဖိုင်များကို ရေးသားခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း မပြုပါ။
- `SOUL.md` သည် bootstrap စာရင်းတွင် မပါဝင်ပါက ဟုခ်သည် မည်သည့်အလုပ်မှ မလုပ်ပါ။

## ဆက်စပ်ကြည့်ရှုရန်

- [Hooks](/automation/hooks)
