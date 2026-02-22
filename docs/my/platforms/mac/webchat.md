---
summary: "mac အက်ပ်က Gateway WebChat ကို မည်သို့ ထည့်သွင်းထားသည်နှင့် ၎င်းကို မည်သို့ ဒီဘဂ်လုပ်ရမည်"
read_when:
  - mac WebChat မြင်ကွင်း သို့မဟုတ် loopback ပေါ့တ်ကို ဒီဘဂ်လုပ်နေချိန်
title: "WebChat"
---

# WebChat (macOS အက်ပ်)

macOS menu bar app သည် WebChat UI ကို native SwiftUI view အဖြစ် embed လုပ်ထားသည်။ ၎င်းသည် Gateway သို့ ချိတ်ဆက်ပြီး ရွေးချယ်ထားသော agent အတွက် **main session** ကို ပုံမှန်အသုံးပြုသည် (အခြား session များအတွက် session switcher ပါရှိသည်)။

- **Local mode**: local Gateway WebSocket သို့ တိုက်ရိုက် ချိတ်ဆက်သည်။
- **Remote mode**: Gateway control ပေါ့တ်ကို SSH ဖြင့် ဖော်ဝတ်လုပ်ပြီး ထိုတန်နယ်ကို ဒေတာပလိန်းအဖြစ် အသုံးပြုသည်။

## Launch & debugging

- လက်ဖြင့်: Lobster မီနူး → “Open Chat”။

- စမ်းသပ်ရန် အလိုအလျောက် ဖွင့်ခြင်း:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- လော့ဂ်များ: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`)။

## How it’s wired

- ဒေတာပလိန်း: Gateway WS နည်းလမ်းများ `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` နှင့် ဖြစ်ရပ်များ `chat`, `agent`, `presence`, `tick`, `health`။
- Session: ပုံမှန်အားဖြင့် primary session (`main`, scope သည် global ဖြစ်ပါက `global`) ကို အသုံးပြုသည်။ UI သည် session များအကြား ပြောင်းနိုင်သည်။
- Onboarding သည် ပထမဆုံး အသုံးပြုချိန် တပ်ဆင်မှုကို ခွဲထားရန် အထူးသီးသန့် ဆက်ရှင်ကို အသုံးပြုသည်။

## Security surface

- Remote mode တွင် Gateway WebSocket control ပေါ့တ်ကိုသာ SSH ဖြင့် ဖော်ဝတ်လုပ်သည်။

## Known limitations

- UI သည် ချတ် ဆက်ရှင်များအတွက် အကောင်းဆုံး အလိုက်သင့် ပြင်ဆင်ထားပြီး (ဘရောက်ဇာ sandbox အပြည့်အစုံ မဟုတ်ပါ)။
