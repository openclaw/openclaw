---
summary: "تكامل PeekabooBridge لأتمتة واجهة مستخدم macOS"
read_when:
  - استضافة PeekabooBridge داخل OpenClaw.app
  - دمج Peekaboo عبر Swift Package Manager
  - تغيير بروتوكول/مسارات PeekabooBridge
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (أتمتة واجهة مستخدم macOS)

يمكن لـ OpenClaw استضافة **PeekabooBridge** كوسيط محلي لأتمتة واجهة المستخدم مع مراعاة الأذونات. يتيح ذلك لـ CLI ‏`peekaboo` قيادة أتمتة واجهة المستخدم مع إعادة استخدام أذونات TCC لتطبيق macOS.

## ما هذا (وما ليس كذلك)

- **المضيف**: يمكن لـ OpenClaw.app العمل كمضيف PeekabooBridge.
- **العميل**: استخدم CLI ‏`peekaboo` (من دون واجهة `openclaw ui ...` منفصلة).
- **واجهة المستخدم**: تظل التراكبات المرئية داخل Peekaboo.app؛ ويعمل OpenClaw كمضيف وسيط رفيع.

## تمكين الجسر

في تطبيق macOS:

- الإعدادات → **تمكين Peekaboo Bridge**

عند التمكين، يبدأ OpenClaw خادم مقبس UNIX محلي. وإذا عُطِّل، يتوقف المضيف وسيعود `peekaboo` لاستخدام المضيفين الآخرين المتاحين.

## ترتيب اكتشاف العميل

عادةً ما تحاول عملاء Peekaboo المضيفين بهذا الترتيب:

1. Peekaboo.app (تجربة مستخدم كاملة)
2. Claude.app (إن كان مثبتًا)
3. OpenClaw.app (وسيط رفيع)

استخدم `peekaboo bridge status --verbose` لمعرفة أي مضيف نشط وأي مسار مقبس قيد الاستخدام. يمكنك التجاوز باستخدام:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## الأمان والأذونات

- يتحقق الجسر من **تواقيع كود المتصل**؛ ويُفرَض Allowlist لمعرّفات TeamID (TeamID لمضيف Peekaboo + TeamID لتطبيق OpenClaw).
- تنتهي مهلة الطلبات بعد نحو 10 ثوانٍ.
- إذا كانت الأذونات المطلوبة مفقودة، يُرجع الجسر رسالة خطأ واضحة بدلًا من تشغيل «إعدادات النظام».

## سلوك اللقطات (الأتمتة)

تُخزَّن اللقطات في الذاكرة وتنتهي صلاحيتها تلقائيًا بعد نافذة قصيرة.
إذا كنت بحاجة إلى احتفاظ أطول، فأعد الالتقاط من العميل.

## استكشاف الأخطاء وإصلاحها

- إذا أفاد `peekaboo` بأن «bridge client is not authorized»، فتأكد من أن العميل موقَّع بشكل صحيح أو شغّل المضيف مع `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  في وضع **debug** فقط.
- إذا لم يُعثر على أي مضيفين، فافتح أحد تطبيقات المضيف (Peekaboo.app أو OpenClaw.app)
  وتأكد من منح الأذونات.
