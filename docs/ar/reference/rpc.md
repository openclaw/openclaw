---
summary: "مهايئات RPC لواجهات CLI الخارجية (signal-cli، imsg القديم) وأنماط Gateway"
read_when:
  - إضافة أو تغيير تكاملات CLI الخارجية
  - تصحيح أخطاء مهايئات RPC (signal-cli، imsg)
title: "مهايئات RPC"
---

# مهايئات RPC

يدمج OpenClaw واجهات CLI الخارجية عبر JSON-RPC. يُستخدم نمطان حاليًا.

## النمط A: خادم HTTP (signal-cli)

- يعمل `signal-cli` كخادم مع JSON-RPC عبر HTTP.
- تدفّق الأحداث هو SSE (`/api/v1/events`).
- فحص السلامة: `/api/v1/check`.
- يمتلك OpenClaw دورة الحياة عندما `channels.signal.autoStart=true`.

اطّلع على [Signal](/channels/signal) للإعداد ونقاط النهاية.

## النمط B: عملية فرعية عبر stdio (قديم: imsg)

> **ملاحظة:** لإعدادات iMessage الجديدة، استخدم [BlueBubbles](/channels/bluebubbles) بدلًا من ذلك.

- يقوم OpenClaw بإنشاء `imsg rpc` كعملية فرعية (تكامل iMessage القديم).
- يكون JSON-RPC محدد الأسطر عبر stdin/stdout (كائن JSON واحد لكل سطر).
- لا يوجد منفذ TCP، ولا حاجة إلى خادم.

الطرائق الأساسية المستخدمة:

- `watch.subscribe` → الإشعارات (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (فحص/تشخيص)

اطّلع على [iMessage](/channels/imessage) للإعداد القديم والعنونة (يُفضّل `chat_id`).

## إرشادات المهايئات

- تمتلك Gateway (البوابة) العملية (البدء/الإيقاف مرتبطان بدورة حياة الموفّر).
- اجعل عملاء RPC مرنين: مهلات، وإعادة التشغيل عند الخروج.
- فَضِّل المعرّفات المستقرة (مثل `chat_id`) على سلاسل العرض.
