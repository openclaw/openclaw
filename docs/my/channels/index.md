---
summary: "OpenClaw ချိတ်ဆက်နိုင်သော မက်ဆေ့ချ်ပို့ဆောင်ရေး ပလက်ဖောင်းများ"
read_when:
  - OpenClaw အတွက် ချတ် ချန်နယ်တစ်ခု ရွေးချယ်လိုသောအခါ
  - ပံ့ပိုးထားသော မက်ဆေ့ချ်ပို့ဆောင်ရေး ပလက်ဖောင်းများကို အမြန်အကျဉ်းချုပ် သိလိုသောအခါ
title: "Chat Channels"
x-i18n:
  source_path: channels/index.md
  source_hash: 6a0e2c70133776d3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:01Z
---

# Chat Channels

OpenClaw သည် သင်နေ့စဉ်အသုံးပြုနေသော မည်သည့် ချတ် အက်ပ်မဆိုမှတစ်ဆင့် သင့်နှင့် ဆက်သွယ်နိုင်ပါသည်။ ချန်နယ်တစ်ခုချင်းစီသည် Gateway မှတစ်ဆင့် ချိတ်ဆက်ပါသည်။
စာသား (Text) ကို ချန်နယ်အားလုံးတွင် ပံ့ပိုးထားပြီး မီဒီယာနှင့် တုံ့ပြန်မှုများ (reactions) သည် ချန်နယ်အလိုက် ကွာခြားပါသည်။

## Supported channels

- [WhatsApp](/channels/whatsapp) — လူကြိုက်အများဆုံး; Baileys ကို အသုံးပြုပြီး QR pairing လိုအပ်ပါသည်။
- [Telegram](/channels/telegram) — grammY မှတစ်ဆင့် Bot API; အုပ်စုများကို ပံ့ပိုးပါသည်။
- [Discord](/channels/discord) — Discord Bot API + Gateway; ဆာဗာများ၊ ချန်နယ်များနှင့် DM မက်ဆေ့ချ်များကို ပံ့ပိုးပါသည်။
- [Slack](/channels/slack) — Bolt SDK; workspace အက်ပ်များ။
- [Feishu](/channels/feishu) — WebSocket မှတစ်ဆင့် Feishu/Lark bot (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Google Chat](/channels/googlechat) — HTTP webhook မှတစ်ဆင့် Google Chat API အက်ပ်။
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; ချန်နယ်များ၊ အုပ်စုများ၊ DM မက်ဆေ့ချ်များ (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Signal](/channels/signal) — signal-cli; ကိုယ်ရေးကိုယ်တာကာကွယ်မှုကို အလေးထားသည်။
- [BlueBubbles](/channels/bluebubbles) — **iMessage အတွက် အကြံပြုထားသည်**; အင်္ဂါရပ်အပြည့်အစုံကို ပံ့ပိုးသော BlueBubbles macOS server REST API ကို အသုံးပြုသည် (တည်းဖြတ်ခြင်း၊ ပြန်ရုပ်သိမ်းခြင်း၊ အကျိုးသက်ရောက်မှုများ၊ တုံ့ပြန်မှုများ၊ အုပ်စုစီမံခန့်ခွဲမှု — macOS 26 Tahoe တွင် လက်ရှိအချိန်တွင် တည်းဖြတ်ခြင်း မအလုပ်လုပ်ပါ)။
- [iMessage (legacy)](/channels/imessage) — imsg CLI မှတစ်ဆင့် legacy macOS ချိတ်ဆက်မှု (အသုံးမပြုတော့ပါ; အသစ်တပ်ဆင်မှုများအတွက် BlueBubbles ကို အသုံးပြုပါ)။
- [Microsoft Teams](/channels/msteams) — Bot Framework; လုပ်ငန်းသုံး ပံ့ပိုးမှု (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [LINE](/channels/line) — LINE Messaging API bot (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk မှတစ်ဆင့် ကိုယ်တိုင်ဟို့စ်ထားသော ချတ် (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Matrix](/channels/matrix) — Matrix protocol (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Nostr](/channels/nostr) — NIP-04 မှတစ်ဆင့် အလယ်မရှိသော DM မက်ဆေ့ချ်များ (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Tlon](/channels/tlon) — Urbit အခြေပြု မက်ဆင်ဂျာ (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Twitch](/channels/twitch) — IRC ချိတ်ဆက်မှုမှတစ်ဆင့် Twitch ချတ် (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Zalo](/channels/zalo) — Zalo Bot API; ဗီယက်နမ်တွင် လူကြိုက်များသော မက်ဆင်ဂျာ (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [Zalo Personal](/channels/zalouser) — QR login မှတစ်ဆင့် Zalo ကိုယ်ရေးကိုယ်တာ အကောင့် (plugin, သီးခြားထည့်သွင်းရပါသည်)။
- [WebChat](/web/webchat) — WebSocket မှတစ်ဆင့် Gateway WebChat UI။

## Notes

- ချန်နယ်များကို တစ်ပြိုင်နက်တည်း လည်ပတ်စေနိုင်ပါသည်; အများအပြားကို ပြင်ဆင်သတ်မှတ်ပြီး OpenClaw သည် ချတ်တစ်ခုချင်းစီအလိုက် လမ်းကြောင်းသတ်မှတ်ပေးပါမည်။
- အမြန်ဆုံး တပ်ဆင်နိုင်သော နည်းလမ်းမှာ ပုံမှန်အားဖြင့် **Telegram** (ရိုးရှင်းသော bot token) ဖြစ်ပါသည်။ WhatsApp သည် QR pairing လိုအပ်ပြီး ဒစ်စ်ပေါ်တွင် အခြေအနေဒေတာ ပိုမို သိမ်းဆည်းပါသည်။
- အုပ်စု လုပ်ဆောင်ပုံများသည် ချန်နယ်အလိုက် ကွာခြားပါသည်; [Groups](/channels/groups) ကို ကြည့်ပါ။
- လုံခြုံရေးအတွက် DM pairing နှင့် allowlists ကို အတင်းအကျပ် အသုံးပြုထားပါသည်; [Security](/gateway/security) ကို ကြည့်ပါ။
- Telegram အတွင်းပိုင်း အချက်အလက်များ: [grammY notes](/channels/grammy)။
- ပြဿနာဖြေရှင်းခြင်း: [Channel troubleshooting](/channels/troubleshooting)။
- မော်ဒယ် ပံ့ပိုးသူများကို သီးခြား စာရွက်စာတမ်းအဖြစ် ဖော်ပြထားပါသည်; [Model Providers](/providers/models) ကို ကြည့်ပါ။
