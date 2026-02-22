---
summary: "Pairing အကျဉ်းချုပ် — မည်သူများက DM ပို့နိုင်မည်ကို အတည်ပြုခြင်း + မည်သည့် နိုဒ်များကို ကွန်ရက်ထဲ ဝင်ခွင့်ပေးမည်ကို သတ်မှတ်ခြင်း"
read_when:
  - DM ဝင်ရောက်ခွင့်ထိန်းချုပ်မှုကို တပ်ဆင်သတ်မှတ်နေချိန်
  - iOS/Android နိုဒ်အသစ်တစ်ခုကို Pairing ပြုလုပ်နေချိန်
  - OpenClaw လုံခြုံရေးအနေအထားကို ပြန်လည်သုံးသပ်နေချိန်
title: "Pairing"
---

# Pairing

“Pairing” သည် OpenClaw ၏ ထင်ရှားပြတ်သားသော **ပိုင်ရှင်အတည်ပြုမှု** အဆင့်ဖြစ်ပါသည်။
၎င်းကို နေရာနှစ်ခုတွင် အသုံးပြုပါသည်။

1. **DM pairing** (ဘော့နှင့် စကားပြောခွင့် ရရှိမည့်သူများ)
2. **Node pairing** (Gateway ကွန်ရက်ထဲသို့ ဝင်ခွင့်ပေးမည့် စက်ပစ္စည်း/နိုဒ်များ)

လုံခြုံရေးအကြောင်းအရာ: [Security](/gateway/security)

## 1. DM pairing (ဝင်ရောက်လာသော ချတ်များအတွက်)

ချန်နယ်တစ်ခုကို DM မူဝါဒ `pairing` ဖြင့် ဖွဲ့စည်းထားပါက၊ မသိရသေးသော ပို့သူများသည် အတိုကောက် ကုဒ်တစ်ခု ရရှိမည်ဖြစ်ပြီး သင်အတည်ပြုမချင်း သူတို့၏ မက်ဆေ့ချ်ကို **မလုပ်ဆောင်သေးပါ**။

မူလ DM မူဝါဒများကို အောက်ပါနေရာတွင် မှတ်တမ်းတင်ထားသည်— [Security](/gateway/security)

Pairing ကုဒ်များ—

- အက္ခရာ ၈ လုံး၊ အက္ခရာကြီးများသာ၊ ရောယှက်နိုင်သော အက္ခရာများ မပါဝင်ပါ (`0O1I`)။
- **၁ နာရီအကြာတွင် သက်တမ်းကုန်ဆုံးမည်**။ Bot သည် pairing မက်ဆေ့ချ်ကို request အသစ်တစ်ခု ဖန်တီးသောအခါသာ ပို့ပါသည် (ပို့သူတစ်ဦးလျှင် တစ်နာရီလောက်တွင် တစ်ကြိမ်ခန့်)။
- စောင့်ဆိုင်းနေသော DM Pairing တောင်းဆိုချက်များကို ပုံမှန်အားဖြင့် **ချန်နယ်တစ်ခုလျှင် ၃ ခု** အထိသာ ခွင့်ပြုထားသည်။ တစ်ခုခု သက်တမ်းကုန်ဆုံးသို့မဟုတ် အတည်ပြုမချင်း ထပ်မံတောင်းဆိုချက်များကို လျစ်လျူရှုပါမည်။

### ပို့သူတစ်ဦးကို အတည်ပြုခြင်း

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

ထောက်ပံ့ထားသော ချန်နယ်များ: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`။

### အခြေအနေ သိမ်းဆည်းထားသော နေရာ

`~/.openclaw/credentials/` အောက်တွင် သိမ်းဆည်းထားသည်—

- စောင့်ဆိုင်းနေသော တောင်းဆိုချက်များ: `<channel>-pairing.json`
- အတည်ပြုထားသော allowlist သိမ်းဆည်းရာ: `<channel>-allowFrom.json`

ဤအချက်အလက်များသည် သင်၏ အကူအညီပေးစနစ်သို့ ဝင်ရောက်ခွင့်ကို ထိန်းချုပ်ပေးသောကြောင့် အထူးလုံခြုံစွာ ကိုင်တွယ်ပါ။

## 2. Node စက်ပစ္စည်း Pairing (iOS/Android/macOS/headless နိုဒ်များ)

Nodes များသည် Gateway သို့ **devices** အဖြစ် `role: node` ဖြင့် ချိတ်ဆက်ပါသည်။ Gateway သည်
အတည်ပြုရမည့် device pairing request တစ်ခုကို ဖန်တီးပါသည်။

### Telegram မှတဆင့် Pair လုပ်ပါ (iOS အတွက် အကြံပြုထားသည်)

`device-pair` plugin ကို အသုံးပြုပါက ပထမအကြိမ် device pairing ကို Telegram ထဲမှတဆင့် အပြည့်အစုံ ပြုလုပ်နိုင်ပါသည်။

1. Telegram တွင် သင့် bot ကို မက်ဆေ့ချ်ပို့ပါ: `/pair`
2. Bot သည် မက်ဆေ့ချ် ၂ ခုဖြင့် ပြန်လည်ဖြေကြားပါသည် — လမ်းညွှန်ချက် မက်ဆေ့ချ်တစ်ခုနှင့် Telegram တွင် copy/paste လုပ်ရ လွယ်ကူသော သီးခြား **setup code** မက်ဆေ့ချ်တစ်ခု။
3. သင့်ဖုန်းတွင် OpenClaw iOS app ကို ဖွင့်ပါ → Settings → Gateway။
4. Setup code ကို paste လုပ်ပြီး ချိတ်ဆက်ပါ။
5. Telegram သို့ ပြန်သွားပြီး: `/pair approve`

Setup code သည် အောက်ပါအချက်များ ပါဝင်သည့် base64-encoded JSON payload ဖြစ်ပါသည် —

- `url`: Gateway WebSocket URL (`ws://...` သို့မဟုတ် `wss://...`)
- `token`: အချိန်ကန့်သတ်ထားသော pairing token

Setup code ကို အသက်ဝင်နေသည့်အချိန်အတွင်း စကားဝှက်တစ်ခုလို သဘောထားပါ။

### Node စက်ပစ္စည်းကို အတည်ပြုခြင်း

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Node Pairing အခြေအနေ သိမ်းဆည်းမှု

`~/.openclaw/devices/` အောက်တွင် သိမ်းဆည်းထားသည်—

- `pending.json` (အချိန်တိုသာ သက်တမ်းရှိ; စောင့်ဆိုင်းနေသော တောင်းဆိုချက်များ သက်တမ်းကုန်ဆုံးနိုင်သည်)
- `paired.json` (Pairing ပြုလုပ်ပြီးသား စက်ပစ္စည်းများ + တိုကင်များ)

### မှတ်ချက်များ

- Legacy `node.pair.*` API (CLI: `openclaw nodes pending/approve`) သည်
  gateway ပိုင်ဆိုင်သော pairing store သီးခြားတစ်ခုဖြစ်ပါသည်။ WS nodes များတွင်လည်း device pairing လိုအပ်နေဆဲဖြစ်ပါသည်။

## ဆက်စပ်စာတမ်းများ

- လုံခြုံရေးမော်ဒယ် + prompt injection: [Security](/gateway/security)
- လုံခြုံစွာ အပ်ဒိတ်လုပ်ခြင်း (doctor ကို chạy): [Updating](/install/updating)
- ချန်နယ် ဖွဲ့စည်းမှုများ:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (အဟောင်း): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
