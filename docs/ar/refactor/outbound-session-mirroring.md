---
title: refactor/outbound-session-mirroring.md #1520)
description: تتبّع ملاحظات إعادة هيكلة عكس الجلسات الصادرة، والقرارات، والاختبارات، والعناصر المفتوحة.
---

# إعادة هيكلة عكس الجلسات الصادرة (المسألة #1520)

## الحالة

- قيد التقدم.
- تم تحديث توجيه القنوات في النواة + الإضافات لعكس الإرسال الصادر.
- إرسال Gateway يستنتج الآن الجلسة المستهدفة عند حذف sessionKey.

## السياق

كانت الإرسالات الصادرة تُعكَس إلى جلسة الوكيل _الحالية_ (مفتاح جلسة الأداة) بدلًا من جلسة القناة المستهدفة. يستخدم التوجيه الوارد مفاتيح جلسات القناة/النظير، لذلك كانت الاستجابات الصادرة تهبط في الجلسة الخاطئة، وغالبًا ما كانت أهداف أول تواصل تفتقر إلى إدخالات جلسة.

## الأهداف

- عكس الرسائل الصادرة إلى مفتاح جلسة القناة المستهدفة.
- إنشاء إدخالات جلسة عند الإرسال الصادر إذا كانت مفقودة.
- الإبقاء على نطاق الخيط/الموضوع متوافقًا مع مفاتيح الجلسات الواردة.
- تغطية القنوات الأساسية بالإضافة إلى الامتدادات المضمّنة.

## ملخص التنفيذ

- مساعد جديد لتوجيه الجلسات الصادرة:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` يبني sessionKey المستهدف باستخدام `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` يكتب `MsgContext` حدّية عبر `recordSessionMetaFromInbound`.
- `runMessageAction` (الإرسال) يستنتج sessionKey المستهدف ويمرّره إلى `executeSendAction` لأغراض العكس.
- `message-tool` لم يعد يعكس مباشرة؛ بل يحل فقط agentId من مفتاح الجلسة الحالي.
- مسار إرسال الإضافات يعكس عبر `appendAssistantMessageToSessionTranscript` باستخدام sessionKey المُستنتج.
- إرسال Gateway يستنتج مفتاح جلسة مستهدف عندما لا يكون مُقدّمًا (الوكيل الافتراضي)، ويضمن وجود إدخال جلسة.

## التعامل مع الخيوط/المواضيع

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (لاحقة).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` مع `useSuffix=false` لمطابقة الوارد (معرّف قناة الخيط يحدد نطاق الجلسة بالفعل).
- Telegram: تُعيَّن معرّفات المواضيع إلى `chatId:topic:<id>` عبر `buildTelegramGroupPeerId`.

## الامتدادات المشمولة

- Matrix، Microsoft Teams، Mattermost، BlueBubbles، Nextcloud Talk، Zalo، Zalo Personal، Nostr، Tlon.
- ملاحظات:
  - أهداف Mattermost تقوم الآن بإزالة `@` لتوجيه مفتاح جلسة الرسائل الخاصة.
  - Zalo Personal يستخدم نوع نظير الرسائل الخاصة لأهداف 1:1 (المجموعة فقط عند وجود `group:`).
  - أهداف مجموعات BlueBubbles تزيل بادئات `chat_*` لمطابقة مفاتيح الجلسات الواردة.
  - عكس الخيوط التلقائي في Slack يطابق معرّفات القنوات دون حساسية لحالة الأحرف.
  - إرسال Gateway يحوّل مفاتيح الجلسات المُقدّمة إلى أحرف صغيرة قبل العكس.

## القرارات

- **اشتقاق جلسة إرسال Gateway**: إذا تم توفير `sessionKey`، فاستعمله. إذا حُذف، فاستنتج sessionKey من الهدف + الوكيل الافتراضي واعكس هناك.
- **إنشاء إدخال جلسة**: استخدم دائمًا `recordSessionMetaFromInbound` مع `Provider/From/To/ChatType/AccountId/Originating*` متوافقًا مع تنسيقات الوارد.
- **تطبيع الهدف**: يستخدم توجيه الإرسال الصادر الأهداف المُحلَّلة (بعد `resolveChannelTarget`) عندما تكون متاحة.
- **حالة أحرف مفتاح الجلسة**: توحيد مفاتيح الجلسات إلى أحرف صغيرة عند الكتابة وخلال عمليات الترحيل.

## الاختبارات المضافة/المحدّثة

- `src/infra/outbound/outbound-session.test.ts`
  - مفتاح جلسة خيط Slack.
  - مفتاح جلسة موضوع Telegram.
  - dmScope identityLinks مع Discord.
- `src/agents/tools/message-tool.test.ts`
  - اشتقاق agentId من مفتاح الجلسة (من دون تمرير sessionKey).
- `src/gateway/server-methods/send.test.ts`
  - اشتقاق مفتاح الجلسة عند حذفه وإنشاء إدخال جلسة.

## عناصر مفتوحة / متابعات

- مكوّن مكالمات الصوت يستخدم مفاتيح جلسات `voice:<phone>` مخصّصة. لم يتم توحيد تعيين الإرسال الصادر هنا؛ إذا كان ينبغي لأداة الرسائل دعم إرسال مكالمات الصوت، فأضِف تعيينًا صريحًا.
- التأكد مما إذا كان أي مكوّن إضافي خارجي يستخدم تنسيقات `From/To` غير قياسية تتجاوز المجموعة المضمّنة.

## الملفات التي تم لمسها

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- الاختبارات في:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
