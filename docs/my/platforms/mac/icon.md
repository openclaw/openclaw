---
summary: "macOS ပေါ်ရှိ OpenClaw အတွက် မီနူးဘား အိုင်ကွန် အခြေအနေများနှင့် အန်နီမေးရှင်းများ"
read_when:
  - မီနူးဘား အိုင်ကွန် အပြုအမူကို ပြောင်းလဲနေချိန်
title: "မီနူးဘား အိုင်ကွန်"
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:45Z
---

# မီနူးဘား အိုင်ကွန် အခြေအနေများ

ရေးသားသူ: steipete · နောက်ဆုံးပြင်ဆင်သည့်ရက်: 2025-12-06 · အကျုံးဝင်မှု: macOS app (`apps/macos`)

- **Idle:** ပုံမှန် အိုင်ကွန် အန်နီမေးရှင်း (မျက်စိပိတ်ဖွင့်ခြင်း၊ အခါအားလျော်စွာ လှုပ်ခါခြင်း)။
- **Paused:** Status item သည် `appearsDisabled` ကို အသုံးပြုသည်; လှုပ်ရှားမှု မရှိပါ။
- **Voice trigger (big ears):** အသံနှိုးဆော်မှုကို တွေ့ရှိသည့်အခါ Voice wake detector က `AppState.triggerVoiceEars(ttl: nil)` ကို ခေါ်ပြီး၊ ပြောဆိုသံကို ဖမ်းယူနေစဉ်အတွင်း `earBoostActive=true` ကို ဆက်လက်ထားရှိသည်။ နားရွက်များကို အရွယ်အစား 1.9x အထိ ချဲ့ပြီး၊ ဖတ်ရှုရလွယ်ကူစေရန် နားရွက်အပေါက်များကို စက်ဝိုင်းပုံစံဖြစ်စေသည်။ ထို့နောက် တိတ်ဆိတ်မှု 1 စက္ကန့် ရှိပြီးပါက `stopVoiceEars()` မှတစ်ဆင့် နားရွက်များကို ပြန်ချသည်။ အက်ပ်အတွင်းရှိ အသံ pipeline မှသာ အလုပ်လုပ်သည်။
- **Working (agent running):** `AppState.isWorking=true` က “tail/leg scurry” မိုက်ခရိုလှုပ်ရှားမှုကို မောင်းနှင်သည် — အလုပ်လုပ်နေစဉ် ခြေထောက် လှုပ်ခါမှု မြန်လာပြီး အနည်းငယ် တစ်ဘက်သို့ ရွေ့လျားမှု ပါဝင်သည်။ လက်ရှိတွင် WebChat agent လည်ပတ်မှုများအတွက်သာ အဖွင့်အပိတ် လုပ်ထားပြီး၊ အခြား ရေရှည် အလုပ်များကို ချိတ်ဆက်သည့်အခါလည်း အလားတူ အဖွင့်အပိတ် ထည့်သွင်းပါ။

Wiring points

- Voice wake: runtime/tester သည် trigger ဖြစ်သည့်အချိန် `AppState.triggerVoiceEars(ttl: nil)` ကို ခေါ်ပြီး၊ ဖမ်းယူချိန်ကာလနှင့် ကိုက်ညီစေရန် တိတ်ဆိတ်မှု 1 စက္ကန့် အပြီး `stopVoiceEars()` ကို ခေါ်ပါ။
- Agent activity: အလုပ်လုပ်သည့် အပိုင်းအခြားများအတွင်း `AppStateStore.shared.setWorking(true/false)` ကို သတ်မှတ်ပါ (WebChat agent call တွင် ပြီးသား)။ အန်နီမေးရှင်း မကပ်နေစေရန် `defer` blocks များတွင် spans များကို တိုတောင်းစွာ ထားပြီး reset လုပ်ပါ။

Shapes & sizes

- အခြေခံ အိုင်ကွန်ကို `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` တွင် ရေးဆွဲထားသည်။
- Ear scale ၏ မူလတန်ဖိုးမှာ `1.0` ဖြစ်ပြီး; voice boost သည် `earScale=1.9` ကို သတ်မှတ်ကာ အလုံးစုံ ဖရိမ်းကို မပြောင်းလဲဘဲ `earHoles=true` ကို အဖွင့်အပိတ် လုပ်သည် (18×18 pt template image ကို 36×36 px Retina backing store ထဲသို့ render လုပ်ထားသည်)။
- Scurry သည် ခြေထောက် လှုပ်ခါမှုကို ~1.0 အထိ အသုံးပြုပြီး အနည်းငယ် အလျားလိုက် လှုပ်ရှားမှု ပါဝင်သည်; ၎င်းသည် ရှိပြီးသား idle wiggle များအပေါ် ထပ်ပေါင်းသက်ရောက်သည်။

Behavioral notes

- နားရွက်/working အတွက် အပြင်ဘက် CLI/broker toggle မရှိပါ; မတော်တဆ အလွန်အမင်း လှုပ်ခါမှု မဖြစ်စေရန် အက်ပ်၏ ကိုယ်ပိုင် signal များအတွင်းသာ ထိန်းသိမ်းထားပါ။
- TTL များကို တိုတောင်းစွာ (&lt;10s) ထားပါ၊ အလုပ်တစ်ခု ချိတ်မိနေပါက အိုင်ကွန်သည် အခြေခံအခြေအနေသို့ လျင်မြန်စွာ ပြန်လည်ရောက်ရှိနိုင်စေရန်။
