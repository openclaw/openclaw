---
summary: "macOS ပေါ်ရှိ OpenClaw အတွက် မီနူးဘား အိုင်ကွန် အခြေအနေများနှင့် အန်နီမေးရှင်းများ"
read_when:
  - မီနူးဘား အိုင်ကွန် အပြုအမူကို ပြောင်းလဲနေချိန်
title: "မီနူးဘား အိုင်ကွန်"
---

# မီနူးဘား အိုင်ကွန် အခြေအနေများ

ရေးသားသူ: steipete · နောက်ဆုံးပြင်ဆင်သည့်ရက်: 2025-12-06 · အကျုံးဝင်မှု: macOS app (`apps/macos`)

- **Idle:** ပုံမှန် အိုင်ကွန် အန်နီမေးရှင်း (မျက်စိပိတ်ဖွင့်ခြင်း၊ အခါအားလျော်စွာ လှုပ်ခါခြင်း)။
- **Paused:** Status item သည် `appearsDisabled` ကို အသုံးပြုသည်; လှုပ်ရှားမှု မရှိပါ။
- 11. **Voice trigger (big ears):** Wake word ကို ကြားသည့်အခါ Voice wake detector သည် `AppState.triggerVoiceEars(ttl: nil)` ကို ခေါ်ပြီး utterance ကို ဖမ်းယူနေစဉ် `earBoostActive=true` ကို ထိန်းထားပါသည်။ 12. Ears များကို (1.9x) အရွယ်အစားတိုးကာ ဖတ်ရှုရလွယ်ရန် စက်ဝိုင်းပုံ ear holes ထည့်ပြီး၊ အသံမရှိသော 1s အပြီး `stopVoiceEars()` ဖြင့် ပြန်လည်ချပါသည်။ 13. In-app voice pipeline မှသာ trigger လုပ်ပါသည်။
- 14. **Working (agent running):** `AppState.isWorking=true` သည် “tail/leg scurry” micro-motion ကို လှုံ့ဆော်ပြီး—အလုပ်လုပ်နေစဉ် ခြေထောက်လှုပ်ရှားမှု ပိုမြန်ပြီး အနည်းငယ် offset ဖြစ်ပါသည်။ 15. လက်ရှိ WebChat agent run အတွင်း toggle လုပ်ထားပြီး၊ အခြား long task များကို wire လုပ်သည့်အခါလည်း အလားတူ toggle ကို ထည့်ပါ။

Wiring points

- Voice wake: runtime/tester သည် trigger ဖြစ်သည့်အချိန် `AppState.triggerVoiceEars(ttl: nil)` ကို ခေါ်ပြီး၊ ဖမ်းယူချိန်ကာလနှင့် ကိုက်ညီစေရန် တိတ်ဆိတ်မှု 1 စက္ကန့် အပြီး `stopVoiceEars()` ကို ခေါ်ပါ။
- 16. Agent activity: အလုပ်လုပ်နေသော span များအပေါ် `AppStateStore.shared.setWorking(true/false)` ကို သတ်မှတ်ပါ (WebChat agent call တွင် ပြီးသား)။ 17. Animation မပိတ်မိစေရန် spans များကို တိုတောင်းစွာထားပြီး `defer` blocks တွင် reset လုပ်ပါ။

Shapes & sizes

- အခြေခံ အိုင်ကွန်ကို `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` တွင် ရေးဆွဲထားသည်။
- Ear scale ၏ မူလတန်ဖိုးမှာ `1.0` ဖြစ်ပြီး; voice boost သည် `earScale=1.9` ကို သတ်မှတ်ကာ အလုံးစုံ ဖရိမ်းကို မပြောင်းလဲဘဲ `earHoles=true` ကို အဖွင့်အပိတ် လုပ်သည် (18×18 pt template image ကို 36×36 px Retina backing store ထဲသို့ render လုပ်ထားသည်)။
- Scurry သည် ခြေထောက် လှုပ်ခါမှုကို ~1.0 အထိ အသုံးပြုပြီး အနည်းငယ် အလျားလိုက် လှုပ်ရှားမှု ပါဝင်သည်; ၎င်းသည် ရှိပြီးသား idle wiggle များအပေါ် ထပ်ပေါင်းသက်ရောက်သည်။

Behavioral notes

- နားရွက်/working အတွက် အပြင်ဘက် CLI/broker toggle မရှိပါ; မတော်တဆ အလွန်အမင်း လှုပ်ခါမှု မဖြစ်စေရန် အက်ပ်၏ ကိုယ်ပိုင် signal များအတွင်းသာ ထိန်းသိမ်းထားပါ။
- TTL များကို တိုတောင်းစွာ (&lt;10s) ထားပါ၊ အလုပ်တစ်ခု ချိတ်မိနေပါက အိုင်ကွန်သည် အခြေခံအခြေအနေသို့ လျင်မြန်စွာ ပြန်လည်ရောက်ရှိနိုင်စေရန်။
