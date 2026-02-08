---
summary: "grammY ကို အသုံးပြုပြီး Telegram Bot API ပေါင်းစည်းမှုနှင့် ဆက်တင်မှတ်စုများ"
read_when:
  - Telegram သို့မဟုတ် grammY လမ်းကြောင်းများတွင် အလုပ်လုပ်နေစဉ်
title: grammY
x-i18n:
  source_path: channels/grammy.md
  source_hash: ea7ef23e6d77801f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:56Z
---

# grammY ပေါင်းစည်းမှု (Telegram Bot API)

# grammY ကို ဘာကြောင့် အသုံးပြုသလဲ

- TS-first Bot API client ဖြစ်ပြီး built-in long-poll + webhook အကူအညီများ၊ middleware၊ error handling၊ rate limiter ပါဝင်သည်။
- fetch + FormData ကို ကိုယ်တိုင်ရေးသားခြင်းထက် မီဒီယာအကူအညီများ ပိုသန့်ရှင်းပြီး Bot API နည်းလမ်းအားလုံးကို ထောက်ပံ့သည်။
- တိုးချဲ့နိုင်မှုကောင်းမွန်သည်—custom fetch ဖြင့် proxy ထောက်ပံ့မှု၊ session middleware (ရွေးချယ်နိုင်)၊ type-safe context။

# ကျွန်ုပ်တို့ တင်ပို့ပြီးသော အရာများ

- **Single client path:** fetch အခြေပြု အကောင်အထည်ဖော်မှုကို ဖယ်ရှားပြီး grammY ကို Telegram client (send + gateway) တစ်ခုတည်းအဖြစ် အသုံးပြုထားသည်။ grammY throttler ကို မူလအနေဖြင့် ဖွင့်ထားသည်။
- **Gateway:** `monitorTelegramProvider` သည် grammY `Bot` ကို တည်ဆောက်ပြီး mention/allowlist gating ကို ချိတ်ဆက်ကာ `getFile`/`download` ဖြင့် မီဒီယာဒေါင်းလုဒ်လုပ်ကာ `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` ဖြင့် ပြန်ကြားချက်များကို ပို့ဆောင်သည်။ `webhookCallback` ဖြင့် long-poll သို့မဟုတ် webhook ကို ထောက်ပံ့သည်။
- **Proxy:** ရွေးချယ်နိုင်သော `channels.telegram.proxy` သည် grammY ၏ `client.baseFetch` မှတစ်ဆင့် `undici.ProxyAgent` ကို အသုံးပြုသည်။
- **Webhook ထောက်ပံ့မှု:** `webhook-set.ts` သည် `setWebhook/deleteWebhook` ကို wrap လုပ်ပြီး `webhook.ts` သည် health + graceful shutdown ဖြင့် callback ကို ဟို့စ်လုပ်သည်။ `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` ကို သတ်မှတ်ထားပါက Gateway သည် webhook မုဒ်ကို ဖွင့်ပြီး (မဟုတ်ပါက long-poll ပြုလုပ်သည်)။
- **Sessions:** direct chats များကို agent ၏ အဓိက session (`agent:<agentId>:<mainKey>`) ထဲသို့ ပေါင်းစည်းသည်။ အုပ်စုများအတွက် `agent:<agentId>:telegram:group:<chatId>` ကို အသုံးပြုသည်။ ပြန်ကြားချက်များကို တူညီသော channel သို့ ပြန်လည်ပို့ဆောင်သည်။
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention မူလတန်ဖိုးများ), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`။
- **Draft streaming:** ရွေးချယ်နိုင်သော `channels.telegram.streamMode` သည် private topic chats (Bot API 9.3+) တွင် `sendMessageDraft` ကို အသုံးပြုသည်။ ၎င်းသည် channel block streaming နှင့် သီးခြားဖြစ်သည်။
- **Tests:** grammy mocks များသည် DM + group mention gating နှင့် outbound send ကို ဖုံးလွှမ်းထားသည်။ မီဒီယာ/webhook fixtures များကို ထပ်မံကြိုဆိုပါသည်။

Open questions

- Bot API 429s ကို ကြုံတွေ့ပါက ရွေးချယ်နိုင်သော grammY plugins (throttler) များကို အသုံးပြုသင့်မသင့်။
- ပိုမိုဖွဲ့စည်းထားသော မီဒီယာစမ်းသပ်မှုများ (sticker များ၊ voice note များ) ကို ထည့်သွင်းရန်။
- webhook listen port ကို ပြင်ဆင်နိုင်အောင် ပြုလုပ်ရန် (လက်ရှိတွင် gateway မှတစ်ဆင့် မချိတ်ဆက်ပါက 8787 သို့ ပုံသေထားသည်)။
