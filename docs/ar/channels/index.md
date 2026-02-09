---
summary: "منصات المراسلة التي يمكن لـ OpenClaw الاتصال بها"
read_when:
  - تريد اختيار قناة دردشة لـ OpenClaw
  - تحتاج إلى نظرة عامة سريعة على منصات المراسلة المدعومة
title: "قنوات الدردشة"
---

# قنوات الدردشة

يمكن لـ OpenClaw التحدث معك على أي تطبيق دردشة تستخدمه بالفعل. تتصل كل قناة عبر Gateway.
النص مدعوم في جميع القنوات؛ بينما تختلف الوسائط وردود الفعل حسب القناة.

## القنوات المدعومة

- [WhatsApp](/channels/whatsapp) — الأكثر شيوعًا؛ يستخدم Baileys ويتطلب إقران QR.
- [Telegram](/channels/telegram) — واجهة Bot API عبر grammY؛ يدعم المجموعات.
- [Discord](/channels/discord) — واجهة Discord Bot API + Gateway؛ يدعم الخوادم والقنوات والرسائل الخاصة.
- [Slack](/channels/slack) — Bolt SDK؛ تطبيقات مساحات العمل.
- [Feishu](/channels/feishu) — بوت Feishu/Lark عبر WebSocket (إضافة، تُثبّت بشكل منفصل).
- [Google Chat](/channels/googlechat) — تطبيق Google Chat API عبر HTTP webhook.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket؛ قنوات ومجموعات ورسائل خاصة (إضافة، تُثبّت بشكل منفصل).
- [Signal](/channels/signal) — signal-cli؛ يركّز على الخصوصية.
- [BlueBubbles](/channels/bluebubbles) — **موصى به لـ iMessage**؛ يستخدم واجهة REST لخادم BlueBubbles على macOS مع دعم كامل للميزات (التعديل، الإلغاء، التأثيرات، ردود الفعل، إدارة المجموعات — التعديل معطّل حاليًا على macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — تكامل macOS قديم عبر imsg CLI (مهمَل، استخدم BlueBubbles للإعدادات الجديدة).
- [Microsoft Teams](/channels/msteams) — Bot Framework؛ دعم مؤسسي (إضافة، تُثبّت بشكل منفصل).
- [LINE](/channels/line) — بوت LINE Messaging API (إضافة، تُثبّت بشكل منفصل).
- [Nextcloud Talk](/channels/nextcloud-talk) — دردشة مستضافة ذاتيًا عبر Nextcloud Talk (إضافة، تُثبّت بشكل منفصل).
- [Matrix](/channels/matrix) — بروتوكول Matrix (إضافة، تُثبّت بشكل منفصل).
- [Nostr](/channels/nostr) — رسائل خاصة لامركزية عبر NIP-04 (إضافة، تُثبّت بشكل منفصل).
- [Tlon](/channels/tlon) — مراسلة مبنية على Urbit (إضافة، تُثبّت بشكل منفصل).
- [Twitch](/channels/twitch) — دردشة Twitch عبر اتصال IRC (إضافة، تُثبّت بشكل منفصل).
- [Zalo](/channels/zalo) — واجهة Zalo Bot API؛ تطبيق المراسلة الشهير في فيتنام (إضافة، تُثبّت بشكل منفصل).
- [Zalo Personal](/channels/zalouser) — حساب Zalo شخصي عبر تسجيل دخول QR (إضافة، تُثبّت بشكل منفصل).
- [WebChat](/web/webchat) — واجهة Gateway WebChat عبر WebSocket.

## ملاحظات

- يمكن تشغيل القنوات في الوقت نفسه؛ قم بتهيئة عدة قنوات وسيقوم OpenClaw بالتوجيه حسب الدردشة.
- غالبًا ما يكون الإعداد الأسرع هو **Telegram** (رمز بوت بسيط). يتطلب WhatsApp إقران QR ويخزّن
  حالة أكبر على القرص.
- يختلف سلوك المجموعات حسب القناة؛ راجع [المجموعات](/channels/groups).
- يتم فرض إقران الرسائل الخاصة وقوائم السماح للسلامة؛ راجع [الأمان](/gateway/security).
- تفاصيل Telegram الداخلية: [ملاحظات grammY](/channels/grammy).
- استكشاف الأخطاء وإصلاحها: [استكشاف أخطاء القنوات وإصلاحها](/channels/troubleshooting).
- يتم توثيق موفّري النماذج بشكل منفصل؛ راجع [موفّرو النماذج](/providers/models).
