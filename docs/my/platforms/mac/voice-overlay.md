---
summary: "wake-word နှင့် push-to-talk တိုက်ဆိုင်လာသောအခါ voice overlay ၏ lifecycle"
read_when:
  - Voice overlay အပြုအမူကို ချိန်ညှိနေစဉ်
title: "Voice Overlay"
---

# Voice Overlay Lifecycle (macOS)

Audience: macOS app contributors. Goal: wake‑word နှင့် push‑to‑talk တိုက်ဆိုင်နေချိန်တွင် voice overlay ကို ခန့်မှန်းနိုင်အောင် ထိန်းထားရန်။

## လက်ရှိ ရည်ရွယ်ချက်

- Wake‑word ကြောင့် overlay မြင်နေပြီးသားဖြစ်သောအချိန် အသုံးပြုသူက hotkey ကို နှိပ်ပါက hotkey session သည် ရှိပြီးသားစာသားကို _လက်ခံယူ_ သုံးစွဲပြီး reset မလုပ်ပါ။ Hotkey ကို ဖိထားသည့်အချိန်အတွင်း overlay သည် ဆက်လက် ပြနေပါသည်။ အသုံးပြုသူ လွှတ်ချလိုက်သည့်အခါ: trim လုပ်ပြီးသား စာသားရှိပါက ပို့ပြီး မရှိပါက ပယ်ဖျက်သည်။
- wake-word တစ်ခုတည်းသာ အသုံးပြုပါက အသံမရှိတော့သည့်အချိန်တွင် အလိုအလျောက် ပို့မည်၊ push-to-talk သည် လွှတ်ချင်းချင်း ပို့မည်။

## အကောင်အထည်ဖော်ပြီးသား (Dec 9, 2025)

- Overlay session များတွင် capture တစ်ကြိမ်စီအတွက် token (wake‑word သို့မဟုတ် push‑to‑talk) ကို ထည့်သွင်းထားသည်။ Token မကိုက်ညီပါက partial/final/send/dismiss/level update များကို ပယ်ချပြီး stale callback များကို ရှောင်ရှားသည်။
- Push‑to‑talk သည် မြင်နေရသော overlay စာသားကို prefix အဖြစ် လက်ခံယူသည် (wake overlay ပြနေစဉ် hotkey ကို နှိပ်လျှင် စာသားကို ထိန်းထားပြီး အသစ်ပြောသော အသံကို ဆက်လက်ပေါင်းထည့်သည်)။ Final transcript ကို အများဆုံး 1.5 စက္ကန့် စောင့်ပြီး မရပါက လက်ရှိစာသားကို အသုံးပြုသည်။
- Chime/overlay logging ကို `info` တွင် categories `voicewake.overlay`, `voicewake.ptt`, နှင့် `voicewake.chime` (session start, partial, final, send, dismiss, chime reason) အဖြစ် ထုတ်လွှင့်ထားပါသည်။

## နောက်တစ်ဆင့်များ

1. **VoiceSessionCoordinator (actor)**
   - တစ်ကြိမ်တည်းတွင် `VoiceSession` တစ်ခုတည်းကိုသာ ပိုင်ဆိုင်ထားပါသည်။
   - API (token အခြေပြု): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`။
   - token ဟောင်းများပါလာသော callback များကို ပယ်ချပါသည် (recognizer ဟောင်းများက overlay ကို ပြန်ဖွင့်မိခြင်းကို တားဆီးရန်)။
2. **VoiceSession (model)**
   - Fields: `token`, `source` (wakeWord|pushToTalk), committed/volatile စာသား၊ chime flags၊ timers (auto-send, idle), `overlayMode` (display|editing|sending), cooldown deadline။
3. **Overlay binding**
   - `VoiceSessionPublisher` (`ObservableObject`) သည် active session ကို SwiftUI ထဲသို့ mirror လုပ်ပေးပါသည်။
   - `VoiceWakeOverlayView` သည် publisher မှတစ်ဆင့်သာ render လုပ်ပြီး global singleton များကို တိုက်ရိုက် မပြောင်းလဲပါ။
   - Overlay အသုံးပြုသူ လုပ်ဆောင်ချက်များ (`sendNow`, `dismiss`, `edit`) သည် session token နှင့်အတူ coordinator ကို ပြန်ခေါ်ပါသည်။
4. **Unified send path**
   - `endCapture` တွင်: trim လုပ်ပြီးနောက် စာသားမရှိပါက → dismiss; မရှိမဖြစ် `performSend(session:)` (send chime ကို တစ်ကြိမ်သာ ဖွင့်ပြီး forward လုပ်ကာ dismiss လုပ်သည်)။
   - Push-to-talk: နှောင့်နှေးမှု မရှိ; wake-word: auto-send အတွက် ရွေးချယ်နိုင်သော delay။
   - Push-to-talk ပြီးဆုံးပြီးနောက် wake runtime အပေါ် short cooldown တစ်ခု သက်ရောက်အောင်လုပ်ပြီး wake-word က ချက်ချင်း ပြန်မထွက်လာစေရန်။
5. **Logging**
   - Coordinator သည် `.info` logs များကို subsystem `bot.molt`, categories `voicewake.overlay` နှင့် `voicewake.chime` တွင် ထုတ်လွှင့်ပါသည်။
   - အရေးပါသော ဖြစ်ရပ်များ: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`။

## Debugging checklist

- sticky overlay ကို ပြန်လည် ဖြစ်ပေါ်စေသည့်အချိန်တွင် logs များကို stream လုပ်ပါ:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- active session token တစ်ခုတည်းသာ ရှိကြောင်း စစ်ဆေးပါ; stale callback များကို coordinator က ပယ်ချထားရပါမည်။

- push-to-talk လွှတ်သည့်အချိန်တိုင်း active token နှင့်အတူ `endCapture` ကို ခေါ်ကြောင်း သေချာစေပါ; စာသားမရှိပါက chime သို့မဟုတ် send မပါဘဲ `dismiss` ဖြစ်လာမည်ဟု မျှော်လင့်ရပါသည်။

## Migration steps (အကြံပြုထားသည်)

1. `VoiceSessionCoordinator`, `VoiceSession`, နှင့် `VoiceSessionPublisher` ကို ထည့်သွင်းပါ။
2. `VoiceWakeRuntime` ကို refactor လုပ်ပြီး `VoiceWakeOverlayController` ကို တိုက်ရိုက် ထိတွေ့မည့်အစား session များကို create/update/end လုပ်ပါ။
3. `VoicePushToTalk` ကို refactor လုပ်၍ ရှိပြီးသား session များကို adopt လုပ်စေပြီး လွှတ်ချိန်တွင် `endCapture` ကို ခေါ်ပါ; runtime cooldown ကို အသုံးချပါ။
4. `VoiceWakeOverlayController` ကို publisher နှင့် ချိတ်ဆက်ပြီး runtime/PTT မှ တိုက်ရိုက်ခေါ်မှုများကို ဖယ်ရှားပါ။
5. session adoption, cooldown, နှင့် empty-text dismissal အတွက် integration tests များ ထည့်သွင်းပါ။
