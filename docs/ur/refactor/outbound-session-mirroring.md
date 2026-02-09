---
title: "آؤٹ باؤنڈ سیشن مررنگ ریفیکٹر (ایشو #1520)" #1520)
description: آؤٹ باؤنڈ سیشن مررنگ کے ریفیکٹر سے متعلق نوٹس، فیصلے، ٹیسٹس، اور کھلے آئٹمز کی ٹریکنگ۔
---

# آؤٹ باؤنڈ سیشن مررنگ ریفیکٹر (ایشو #1520)

## اسٹیٹس

- جاری ہے۔
- آؤٹ باؤنڈ مررنگ کے لیے کور + پلگ اِن چینل روٹنگ اپ ڈیٹ کر دی گئی ہے۔
- Gateway send اب اس صورت میں ہدف سیشن اخذ کرتا ہے جب sessionKey مہیا نہ ہو۔

## سیاق

آؤٹ باؤنڈ بھیجے گئے پیغامات کو ہدف چینل سیشن کے بجائے _موجودہ_ ایجنٹ سیشن (ٹول سیشن کی) میں عکس بند کیا گیا۔ ان باؤنڈ روٹنگ چینل/پیئر سیشن کیز استعمال کرتی ہے، اس لیے آؤٹ باؤنڈ جوابات غلط سیشن میں پہنچ گئے اور پہلی بار رابطہ کرنے والے اہداف میں اکثر سیشن اندراجات موجود نہیں تھے۔

## اہداف

- آؤٹ باؤنڈ پیغامات کو ہدف چینل سیشن کی میں مرر کرنا۔
- آؤٹ باؤنڈ پر سیشن انٹریز بنانا جب وہ موجود نہ ہوں۔
- تھریڈ/موضوع کی اسکوپنگ کو اِن باؤنڈ سیشن کیز کے ساتھ ہم آہنگ رکھنا۔
- کور چینلز کے ساتھ بنڈلڈ ایکسٹینشنز کو بھی کور کرنا۔

## امپلیمینٹیشن کا خلاصہ

- نیا آؤٹ باؤنڈ سیشن روٹنگ ہیلپر:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` ہدف sessionKey کو `buildAgentSessionKey` (dmScope + identityLinks) کے ذریعے بناتا ہے۔
  - `ensureOutboundSessionEntry` کم از کم `MsgContext` کو `recordSessionMetaFromInbound` کے ذریعے لکھتا ہے۔
- `runMessageAction` (send) ہدف sessionKey اخذ کرتا ہے اور مررنگ کے لیے اسے `executeSendAction` کو پاس کرتا ہے۔
- `message-tool` اب براہِ راست مرر نہیں کرتا؛ یہ صرف موجودہ سیشن کی سے agentId حل کرتا ہے۔
- پلگ اِن send پاتھ اخذ شدہ sessionKey استعمال کرتے ہوئے `appendAssistantMessageToSessionTranscript` کے ذریعے مرر کرتا ہے۔
- Gateway send اس صورت میں ہدف سیشن کی اخذ کرتا ہے جب کوئی فراہم نہ کی گئی ہو (ڈیفالٹ ایجنٹ)، اور سیشن انٹری کو یقینی بناتا ہے۔

## تھریڈ/موضوع ہینڈلنگ

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (سفکس)۔
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` کے ساتھ `useSuffix=false` تاکہ اِن باؤنڈ سے میچ ہو (تھریڈ چینل آئی ڈی پہلے ہی سیشن کو اسکوپ کرتا ہے)۔
- Telegram: ٹاپک آئی ڈیز `buildTelegramGroupPeerId` کے ذریعے `chatId:topic:<id>` میں میپ ہوتی ہیں۔

## کور کی گئی ایکسٹینشنز

- Matrix، MS Teams، Mattermost، BlueBubbles، Nextcloud Talk، Zalo، Zalo Personal، Nostr، Tlon۔
- نوٹس:
  - Mattermost ٹارگٹس اب DM سیشن کی روٹنگ کے لیے `@` کو اسٹرپ کرتے ہیں۔
  - Zalo Personal 1:1 ٹارگٹس کے لیے DM پیئر کنڈ استعمال کرتا ہے (گروپ صرف اس وقت جب `group:` موجود ہو)۔
  - BlueBubbles گروپ ٹارگٹس اِن باؤنڈ سیشن کیز سے میچ کرنے کے لیے `chat_*` پریفکسز اسٹرپ کرتے ہیں۔
  - Slack آٹو-تھریڈ مررنگ چینل آئی ڈیز کو کیس اِن سینسِٹو طور پر میچ کرتی ہے۔
  - Gateway send مررنگ سے پہلے فراہم کردہ سیشن کیز کو لوئرکیس کرتا ہے۔

## فیصلے

- **گیٹ وے سینڈ سیشن ڈیریویشن**: اگر `sessionKey` فراہم کیا گیا ہو تو اسے استعمال کریں۔ اگر فراہم نہ ہو تو ہدف + ڈیفالٹ ایجنٹ سے ایک sessionKey اخذ کریں اور وہیں عکس بند کریں۔
- **سیشن انٹری کی تخلیق**: ہمیشہ `recordSessionMetaFromInbound` کو `Provider/From/To/ChatType/AccountId/Originating*` کے ساتھ استعمال کریں جو اِن باؤنڈ فارمیٹس کے ساتھ ہم آہنگ ہو۔
- **ٹارگٹ نارملائزیشن**: آؤٹ باؤنڈ روٹنگ دستیاب ہونے پر حل شدہ ٹارگٹس (post `resolveChannelTarget`) استعمال کرتی ہے۔
- **سیشن کی کیس**: لکھتے وقت اور مائیگریشنز کے دوران سیشن کیز کو لوئرکیس میں کینونیکلائز کریں۔

## شامل/اپ ڈیٹ کیے گئے ٹیسٹس

- `src/infra/outbound/outbound-session.test.ts`
  - Slack تھریڈ سیشن کی۔
  - Telegram ٹاپک سیشن کی۔
  - Discord کے ساتھ dmScope identityLinks۔
- `src/agents/tools/message-tool.test.ts`
  - سیشن کی سے agentId اخذ کرتا ہے (کوئی sessionKey پاس تھرو نہیں کیا گیا)۔
- `src/gateway/server-methods/send.test.ts`
  - sessionKey کے اخراج (جب فراہم نہ ہو) اور سیشن انٹری کی تخلیق۔

## کھلے آئٹمز / فالو اپس

- وائس کال پلگ اِن کسٹم `voice:<phone>` سیشن کیز استعمال کرتا ہے۔ آؤٹ باؤنڈ میپنگ یہاں معیاری نہیں ہے؛ اگر میسج ٹول کو وائس کال بھیجنے کی سپورٹ دینی ہو تو واضح میپنگ شامل کریں۔
- تصدیق کریں کہ آیا کوئی بیرونی پلگ اِن بنڈلڈ سیٹ سے ہٹ کر غیر معیاری `From/To` فارمیٹس استعمال کرتا ہے یا نہیں۔

## متاثرہ فائلیں

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- ٹیسٹس میں:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
