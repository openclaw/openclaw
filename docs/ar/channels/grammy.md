---
summary: "تكامل Telegram Bot API عبر grammY مع ملاحظات الإعداد"
read_when:
  - عند العمل على مسارات Telegram أو grammY
title: grammY
---

# تكامل grammY ‏(Telegram Bot API)

# لماذا grammY

- عميل Bot API يعتمد TS أولًا مع مساعدات مدمجة للاستطلاع الطويل (long-poll) والويبهوك، والبرمجيات الوسيطة (middleware)، ومعالجة الأخطاء، ومحدِّد المعدّل.
- أدوات وسائط أنظف مقارنةً ببناء fetch + FormData يدويًا؛ يدعم جميع أساليب Bot API.
- قابلية التوسّع: دعم الوكيل عبر fetch مخصّص، وبرمجيات جلسات وسيطة (اختيارية)، وسياق آمن الأنواع.

# ما الذي قمنا بشحنه

- **مسار عميل واحد:** أزيل تنفيذ يعتمد على fetch؛ وأصبح grammY عميل Telegram الوحيد (الإرسال + Gateway) مع تفعيل محدِّد grammY افتراضيًا.
- **Gateway:** يبني `monitorTelegramProvider` `Bot` باستخدام grammY، ويصل بوابات الذِكر/قائمة السماح، وتنزيل الوسائط عبر `getFile`/`download`، ويُسلِّم الردود باستخدام `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. يدعم الاستطلاع الطويل أو الويبهوك عبر `webhookCallback`.
- **الوكيل:** خيار `channels.telegram.proxy` يستخدم `undici.ProxyAgent` عبر `client.baseFetch` الخاصة بـ grammY.
- **دعم الويبهوك:** يقوم `webhook-set.ts` بتغليف `setWebhook/deleteWebhook`؛ ويستضيف `webhook.ts` الاستدعاء الراجع مع فحص الصحة وإيقاف تشغيل رشيق. يفعّل Gateway وضع الويبهوك عند ضبط `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (وإلا فسيستخدم الاستطلاع الطويل).
- **الجلسات:** تُدمج الدردشات المباشرة في جلسة الوكيل الرئيسية (`agent:<agentId>:<mainKey>`)؛ وتستخدم المجموعات `agent:<agentId>:telegram:group:<chatId>`؛ وتُعاد توجيه الردود إلى القناة نفسها.
- **مقابض التهيئة:** `channels.telegram.botToken`، `channels.telegram.dmPolicy`، `channels.telegram.groups` (إعدادات افتراضية لقائمة السماح والذِكر)، `channels.telegram.allowFrom`، `channels.telegram.groupAllowFrom`، `channels.telegram.groupPolicy`، `channels.telegram.mediaMaxMb`، `channels.telegram.linkPreview`، `channels.telegram.proxy`، `channels.telegram.webhookSecret`، `channels.telegram.webhookUrl`.
- **بثّ المسودات:** خيار `channels.telegram.streamMode` يستخدم `sendMessageDraft` في محادثات الموضوعات الخاصة (Bot API 9.3+). هذا منفصل عن بثّ الكتل على القنوات.
- **الاختبارات:** تغطي محاكيات grammY الرسائل الخاصة (DM) وحراسة الذِكر في المجموعات والإرسال الصادر؛ ولا تزال تجهيزات وسائط/ويبهوك إضافية مرحّبًا بها.

أسئلة مفتوحة

- إضافات grammY الاختيارية (محدِّد المعدّل) إذا واجهنا أخطاء Bot API ‏429.
- إضافة اختبارات وسائط أكثر تنظيمًا (ملصقات، ملاحظات صوتية).
- جعل منفذ الاستماع للويبهوك قابلًا للتهيئة (حاليًا ثابت على 8787 ما لم يُربط عبر Gateway).
