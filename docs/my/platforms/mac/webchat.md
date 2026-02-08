---
summary: "mac အက်ပ်က Gateway WebChat ကို မည်သို့ ထည့်သွင်းထားသည်နှင့် ၎င်းကို မည်သို့ ဒီဘဂ်လုပ်ရမည်"
read_when:
  - mac WebChat မြင်ကွင်း သို့မဟုတ် loopback ပေါ့တ်ကို ဒီဘဂ်လုပ်နေချိန်
title: "WebChat"
x-i18n:
  source_path: platforms/mac/webchat.md
  source_hash: 7c425374673b817a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:40Z
---

# WebChat (macOS အက်ပ်)

macOS မီနူးဘား အက်ပ်သည် WebChat UI ကို native SwiftUI view အဖြစ် ထည့်သွင်းထားသည်။ ၎င်းသည် Gateway（ဂိတ်ဝေး）နှင့် ချိတ်ဆက်ပြီး ရွေးချယ်ထားသော အေးဂျင့်အတွက် **အဓိက ဆက်ရှင်** ကို ပုံမှန် အသုံးပြုသည် (အခြား ဆက်ရှင်များအတွက် ဆက်ရှင်ပြောင်းကိရိယာ ပါရှိသည်)။

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
- ဆက်ရှင်: ပုံမှန်အားဖြင့် အဓိက ဆက်ရှင် (`main`၊ သို့မဟုတ် scope သည် global ဖြစ်လျှင် `global`) ကို အသုံးပြုသည်။ UI မှ ဆက်ရှင်များအကြား ပြောင်းနိုင်သည်။
- Onboarding သည် ပထမဆုံး အသုံးပြုချိန် တပ်ဆင်မှုကို ခွဲထားရန် အထူးသီးသန့် ဆက်ရှင်ကို အသုံးပြုသည်။

## Security surface

- Remote mode တွင် Gateway WebSocket control ပေါ့တ်ကိုသာ SSH ဖြင့် ဖော်ဝတ်လုပ်သည်။

## Known limitations

- UI သည် ချတ် ဆက်ရှင်များအတွက် အကောင်းဆုံး အလိုက်သင့် ပြင်ဆင်ထားပြီး (ဘရောက်ဇာ sandbox အပြည့်အစုံ မဟုတ်ပါ)။
