---
title: Outbound ဆက်ရှင် မီရရင် ပြန်လည်ဖွဲ့စည်းခြင်း (Issue #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
x-i18n:
  source_path: refactor/outbound-session-mirroring.md
  source_hash: b88a72f36f7b6d8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:05Z
---

# Outbound ဆက်ရှင် မီရရင် ပြန်လည်ဖွဲ့စည်းခြင်း (Issue #1520)

## အခြေအနေ

- လုပ်ဆောင်ဆဲ။
- Outbound mirroring အတွက် Core + plugin ချန်နယ် လမ်းကြောင်းသတ်မှတ်မှုကို အပ်ဒိတ်လုပ်ပြီး။
- Gateway send သည် sessionKey မပေးထားပါက ပစ်မှတ် ဆက်ရှင်ကို ယခု အလိုအလျောက် ဆင်းသက်သတ်မှတ်နိုင်သည်။

## နောက်ခံအကြောင်းအရာ

Outbound ပို့ဆောင်မှုများကို ပစ်မှတ် ချန်နယ် ဆက်ရှင်အစား လက်ရှိ အေးဂျင့် ဆက်ရှင် (tool session key) ထဲသို့ မီရရင်လုပ်နေခဲ့သည်။ Inbound လမ်းကြောင်းသတ်မှတ်မှုတွင် channel/peer session keys ကို အသုံးပြုသောကြောင့် outbound အဖြေများသည် မှားယွင်းသော ဆက်ရှင်ထဲသို့ ရောက်ရှိခဲ့ပြီး ပထမဆုံး ဆက်သွယ်မှုရှိသည့် ပစ်မှတ်များတွင် ဆက်ရှင် အချက်အလက်များ မရှိသေးသော အခြေအနေများ ဖြစ်ပေါ်ခဲ့သည်။

## ရည်မှန်းချက်များ

- Outbound မက်ဆေ့ချ်များကို ပစ်မှတ် ချန်နယ် ဆက်ရှင် key ထဲသို့ မီရရင်လုပ်ရန်။
- Outbound အချိန်တွင် ဆက်ရှင် မရှိပါက ဆက်ရှင် အချက်အလက်များ ဖန်တီးရန်။
- Thread/topic သတ်မှတ်မှုကို inbound ဆက်ရှင် keys နှင့် ကိုက်ညီစေရန် ထိန်းထားရန်။
- Core ချန်နယ်များနှင့် bundled extensions အားလုံးကို ဖုံးလွှမ်းစေရန်။

## အကောင်အထည်ဖော်မှု အကျဉ်းချုပ်

- Outbound ဆက်ရှင် လမ်းကြောင်းသတ်မှတ်ရေး helper အသစ်။
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` သည် `buildAgentSessionKey` (dmScope + identityLinks) ကို အသုံးပြုပြီး ပစ်မှတ် sessionKey ကို တည်ဆောက်သည်။
  - `ensureOutboundSessionEntry` သည် `recordSessionMetaFromInbound` မှတစ်ဆင့် အနည်းဆုံး `MsgContext` ကို ရေးသားသည်။
- `runMessageAction` (send) သည် ပစ်မှတ် sessionKey ကို ဆင်းသက်သတ်မှတ်ပြီး မီရရင်လုပ်ရန်အတွက် `executeSendAction` သို့ ပို့ပေးသည်။
- `message-tool` သည် တိုက်ရိုက် မီရရင် မလုပ်တော့ဘဲ လက်ရှိ ဆက်ရှင် key မှ agentId ကိုသာ ဖြေရှင်းပေးသည်။
- Plugin send လမ်းကြောင်းတွင် ဆင်းသက်သတ်မှတ်ထားသော sessionKey ကို အသုံးပြုပြီး `appendAssistantMessageToSessionTranscript` မှတစ်ဆင့် မီရရင်လုပ်သည်။
- Gateway send သည် session key မပေးထားပါက (default agent) ပစ်မှတ် ဆက်ရှင် key ကို ဆင်းသက်သတ်မှတ်ပြီး ဆက်ရှင် အချက်အလက်တစ်ခု ရှိနေကြောင်း သေချာစေသည်။

## Thread/Topic ကိုင်တွယ်မှု

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix)။
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` ကို `useSuffix=false` နှင့်အတူ အသုံးပြုပြီး inbound နှင့် ကိုက်ညီစေသည် (thread channel id သည် ဆက်ရှင်ကို အလျော်အစား သတ်မှတ်ပြီးသားဖြစ်သည်)။
- Telegram: topic IDs များကို `buildTelegramGroupPeerId` မှတစ်ဆင့် `chatId:topic:<id>` သို့ မပ်ပြောင်းသည်။

## ဖုံးလွှမ်းထားသော Extensions များ

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon။
- မှတ်ချက်များ။
  - Mattermost ပစ်မှတ်များသည် DM ဆက်ရှင် key လမ်းကြောင်းသတ်မှတ်မှုအတွက် `@` ကို ယခု ဖယ်ရှားသည်။
  - Zalo Personal သည် 1:1 ပစ်မှတ်များအတွက် DM peer kind ကို အသုံးပြုသည် (`group:` ရှိပါကသာ group ဖြစ်သည်)။
  - BlueBubbles group ပစ်မှတ်များသည် inbound ဆက်ရှင် keys နှင့် ကိုက်ညီစေရန် `chat_*` prefixes များကို ဖယ်ရှားသည်။
  - Slack auto-thread မီရရင်သည် channel ids များကို case-insensitive အဖြစ် ကိုက်ညီစေသည်။
  - Gateway send သည် ပေးထားသော session keys များကို မီရရင်မလုပ်မီ lowercase ပြောင်းသည်။

## ဆုံးဖြတ်ချက်များ

- **Gateway send ဆက်ရှင် ဆင်းသက်သတ်မှတ်မှု**: `sessionKey` ကို ပေးထားပါက ထိုကီးကို အသုံးပြုသည်။ မပေးထားပါက ပစ်မှတ် + default agent မှ sessionKey ကို ဆင်းသက်သတ်မှတ်ပြီး ထိုနေရာတွင် မီရရင်လုပ်သည်။
- **ဆက်ရှင် အချက်အလက် ဖန်တီးမှု**: inbound ပုံစံများနှင့် ကိုက်ညီစေရန် `Provider/From/To/ChatType/AccountId/Originating*` ပါဝင်သော `recordSessionMetaFromInbound` ကို အမြဲ အသုံးပြုသည်။
- **ပစ်မှတ် ပုံမှန်化**: outbound လမ်းကြောင်းသတ်မှတ်မှုသည် ရရှိနိုင်ပါက ဖြေရှင်းပြီးသား ပစ်မှတ်များ ( `resolveChannelTarget` ပြီးနောက် ) ကို အသုံးပြုသည်။
- **ဆက်ရှင် key စာလုံးအကြီးအသေး**: ရေးသားချိန်နှင့် migration အတွင်း session keys များကို lowercase အဖြစ် canonicalize လုပ်သည်။

## ထည့်သွင်း/အပ်ဒိတ်လုပ်ထားသော စမ်းသပ်မှုများ

- `src/infra/outbound/outbound-session.test.ts`
  - Slack thread ဆက်ရှင် key။
  - Telegram topic ဆက်ရှင် key။
  - Discord နှင့် dmScope identityLinks။
- `src/agents/tools/message-tool.test.ts`
  - session key မှ agentId ကို ဆင်းသက်သတ်မှတ်သည် (sessionKey ကို မပို့ဆောင်ပါ)။
- `src/gateway/server-methods/send.test.ts`
  - session key ကို မပေးထားပါက ဆင်းသက်သတ်မှတ်ပြီး ဆက်ရှင် အချက်အလက် ဖန်တီးသည်။

## ဖွင့်လှစ်ထားသော အချက်များ / နောက်ဆက်တွဲ လုပ်ဆောင်ရန်များ

- Voice-call plugin သည် စိတ်ကြိုက် `voice:<phone>` ဆက်ရှင် keys ကို အသုံးပြုနေသည်။ Outbound မပ်ပြောင်းမှုကို ဤနေရာတွင် စံမထားရသေးပါ။ message-tool မှ voice-call ပို့ဆောင်မှုများကို ထောက်ပံ့ရမည်ဆိုပါက ထူးခြားသည့် mapping ကို ထည့်သွင်းရန်လိုအပ်သည်။
- Bundled set ထက် ကျော်လွန်ပြီး မည်သည့် external plugin မဆို non-standard `From/To` ပုံစံများကို အသုံးပြုနေသလားကို အတည်ပြုရန်။

## ထိတွေ့ပြင်ဆင်ခဲ့သော ဖိုင်များ

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- စမ်းသပ်မှုများ။
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
