---
summary: "خطوات فحص السلامة لاتصال القنوات"
read_when:
  - تشخيص سلامة قناة WhatsApp
title: "الفحص الصحي"
---

# فحوصات السلامة (CLI)

دليل مختصر للتحقق من اتصال القنوات دون تخمين.

## فحوصات سريعة

- `openclaw status` — ملخص محلي: إمكانية الوصول إلى Gateway/الوضع، تلميح التحديث، عمر مصادقة القناة المرتبطة، الجلسات + النشاط الأخير.
- `openclaw status --all` — تشخيص محلي كامل (للقراءة فقط، ملوّن، وآمن للمشاركة لأغراض التصحيح).
- `openclaw status --deep` — يفحص أيضًا Gateway العامل (فحوصات لكل قناة عند توفر الدعم).
- `openclaw health --json` — يطلب من Gateway العامل لقطة سلامة كاملة (خاص بـ WS فقط؛ بدون مقبس Baileys مباشر).
- أرسل `/status` كرسالة مستقلة في WhatsApp/WebChat للحصول على رد حالة دون استدعاء الوكيل.
- السجلات: تتبّع `/tmp/openclaw/openclaw-*.log` وفلترة `web-heartbeat`، `web-reconnect`، `web-auto-reply`، `web-inbound`.

## تشخيصات متعمقة

- بيانات الاعتماد على القرص: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (يجب أن يكون وقت التعديل mtime حديثًا).
- مخزن الجلسات: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (يمكن تجاوز المسار في التهيئة). يتم إظهار العدد والمستلمين الأخيرين عبر `status`.
- مسار إعادة الربط: `openclaw channels logout && openclaw channels login --verbose` عند ظهور رموز الحالة 409–515 أو `loggedOut` في السجلات. (ملاحظة: تدفق تسجيل الدخول عبر QR يُعاد تشغيله تلقائيًا مرة واحدة عند الحالة 515 بعد الاقتران).

## عند حدوث فشل

- `logged out` أو الحالة 409–515 → أعد الربط باستخدام `openclaw channels logout` ثم `openclaw channels login`.
- تعذّر الوصول إلى Gateway → شغّله: `openclaw gateway --port 18789` (استخدم `--force` إذا كان المنفذ مشغولًا).
- عدم وصول رسائل واردة → تأكّد من أن الهاتف المرتبط متصل وأن المرسل مسموح (`channels.whatsapp.allowFrom`)؛ وبالنسبة لمحادثات المجموعات، تأكّد من تطابق قواعد قائمة السماح + الإشارة (`channels.whatsapp.groups`، `agents.list[].groupChat.mentionPatterns`).

## أمر «health» مخصّص

`openclaw health --json` يطلب من Gateway العامل لقطة سلامته (دون مقابس قنوات مباشرة من CLI). يبلّغ عن بيانات الاعتماد/عمر المصادقة المرتبطة عند توفرها، وملخصات فحوصات لكل قناة، وملخص مخزن الجلسات، ومدة الفحص. ينهي التنفيذ بحالة غير صفرية إذا تعذّر الوصول إلى Gateway أو فشل الفحص/انتهت المهلة. استخدم `--timeout <ms>` لتجاوز المهلة الافتراضية البالغة 10 ثوانٍ.
