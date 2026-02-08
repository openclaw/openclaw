---
summary: "Pairing အကျဉ်းချုပ် — မည်သူများက DM ပို့နိုင်မည်ကို အတည်ပြုခြင်း + မည်သည့် နိုဒ်များကို ကွန်ရက်ထဲ ဝင်ခွင့်ပေးမည်ကို သတ်မှတ်ခြင်း"
read_when:
  - DM ဝင်ရောက်ခွင့်ထိန်းချုပ်မှုကို တပ်ဆင်သတ်မှတ်နေချိန်
  - iOS/Android နိုဒ်အသစ်တစ်ခုကို Pairing ပြုလုပ်နေချိန်
  - OpenClaw လုံခြုံရေးအနေအထားကို ပြန်လည်သုံးသပ်နေချိန်
title: "Pairing"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:04Z
---

# Pairing

“Pairing” သည် OpenClaw ၏ **ပိုင်ရှင်အတည်ပြုချက်** ကို ထင်ရှားစွာ လိုအပ်စေသော အဆင့်ဖြစ်သည်။
အောက်ပါနေရာနှစ်ခုတွင် အသုံးပြုသည်—

1. **DM pairing** (ဘော့နှင့် စကားပြောခွင့် ရရှိမည့်သူများ)
2. **Node pairing** (Gateway ကွန်ရက်ထဲသို့ ဝင်ခွင့်ပေးမည့် စက်ပစ္စည်း/နိုဒ်များ)

လုံခြုံရေးအကြောင်းအရာ: [Security](/gateway/security)

## 1) DM pairing (ဝင်ရောက်လာသော ချတ်များအတွက်)

ချန်နယ်တစ်ခုကို DM မူဝါဒ `pairing` ဖြင့် ဖွဲ့စည်းထားပါက၊ မသိရသေးသော ပို့သူများသည် အတိုကောက် ကုဒ်တစ်ခု ရရှိမည်ဖြစ်ပြီး သင်အတည်ပြုမချင်း သူတို့၏ မက်ဆေ့ချ်ကို **မလုပ်ဆောင်သေးပါ**။

မူလ DM မူဝါဒများကို အောက်ပါနေရာတွင် မှတ်တမ်းတင်ထားသည်— [Security](/gateway/security)

Pairing ကုဒ်များ—

- အက္ခရာ ၈ လုံး၊ အက္ခရာကြီးများသာ၊ ရောယှက်နိုင်သော အက္ခရာများ မပါဝင်ပါ (`0O1I`)။
- **၁ နာရီအကြာတွင် သက်တမ်းကုန်ဆုံးမည်**။ ပို့သူတစ်ဦးချင်းစီအလိုက် တစ်နာရီခန့်တစ်ကြိမ်သာ Pairing မက်ဆေ့ချ်ကို ပို့ပါသည် (တောင်းဆိုချက်အသစ် တစ်ခု ဖန်တီးသောအချိန်တွင်သာ)။
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

## 2) Node စက်ပစ္စည်း Pairing (iOS/Android/macOS/headless နိုဒ်များ)

နိုဒ်များသည် `role: node` ဖြင့် **စက်ပစ္စည်းများ** အဖြစ် Gateway（ဂိတ်ဝေး）သို့ ချိတ်ဆက်ပါသည်။ Gateway（ဂိတ်ဝေး）က အတည်ပြုရန်လိုအပ်သော စက်ပစ္စည်း Pairing တောင်းဆိုချက်ကို ဖန်တီးပါသည်။

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

- အဟောင်း `node.pair.*` API (CLI: `openclaw nodes pending/approve`) သည်
  Gateway ပိုင် Pairing သိမ်းဆည်းရာ သီးခြားတစ်ခု ဖြစ်ပါသည်။ WS နိုဒ်များသည် စက်ပစ္စည်း Pairing ကို မဖြစ်မနေ လိုအပ်နေဆဲ ဖြစ်သည်။

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
