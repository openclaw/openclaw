---
summary: "معمارية IPC على macOS لتطبيق OpenClaw ونقل عُقدة Gateway وPeekabooBridge"
read_when:
  - عند تحرير عقود IPC أو IPC لتطبيق شريط القوائم
title: "IPC على macOS"
---

# معمارية OpenClaw لـ IPC على macOS

**النموذج الحالي:** يقوم مقبس Unix محلي بربط **خدمة مضيف العُقدة** بـ **تطبيق macOS** للموافقة على exec + `system.run`. يتوفر CLI تصحيح أخطاء `openclaw-mac` لعمليات الاكتشاف/فحوصات الاتصال؛ بينما تستمر إجراءات الوكيل عبر WebSocket الخاص بـ Gateway و`node.invoke`. تعتمد أتمتة واجهة المستخدم على PeekabooBridge.

## الأهداف

- مثيل واحد لتطبيق واجهة المستخدم الرسومية يمتلك جميع الأعمال المواجهة لـ TCC (الإشعارات، تسجيل الشاشة، الميكروفون، الكلام، AppleScript).
- سطح صغير للأتمتة: Gateway + أوامر العُقدة، بالإضافة إلى PeekabooBridge لأتمتة واجهة المستخدم.
- أذونات متوقعة: دائمًا نفس معرّف الحزمة الموقّع، ويتم الإطلاق بواسطة launchd، بحيث تبقى منح TCC ثابتة.

## كيفية العمل

### نقل Gateway + العُقدة

- يقوم التطبيق بتشغيل Gateway (الوضع المحلي) ويتصل به كعُقدة.
- تُنفَّذ إجراءات الوكيل عبر `node.invoke` (مثل `system.run`، `system.notify`، `canvas.*`).

### خدمة العُقدة + IPC للتطبيق

- تتصل خدمة مضيف عُقدة بدون واجهة مستخدم بـ WebSocket الخاص بـ Gateway.
- تُعاد توجيه طلبات `system.run` إلى تطبيق macOS عبر مقبس Unix محلي.
- ينفّذ التطبيق عملية exec ضمن سياق واجهة المستخدم، ويطلب الإذن عند الحاجة، ثم يعيد المخرجات.

المخطط (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (أتمتة واجهة المستخدم)

- تستخدم أتمتة واجهة المستخدم مقبس UNIX منفصلًا باسم `bridge.sock` وبروتوكول JSON الخاص بـ PeekabooBridge.
- ترتيب تفضيل المضيف (على جهة العميل): Peekaboo.app → Claude.app → OpenClaw.app → التنفيذ المحلي.
- الأمان: تتطلب مضيفات الجسر TeamID مسموحًا به؛ ويوجد منفذ هروب DEBUG-only بنفس UID محمي بواسطة `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (وفق اصطلاح Peekaboo).
- راجع: [استخدام PeekabooBridge](/platforms/mac/peekaboo) للتفاصيل.

## التدفقات التشغيلية

- إعادة التشغيل/إعادة البناء: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - قتل مثيلات موجودة
  - بناء Swift + التحزيم
  - كتابة/تهيئة/تشغيل LaunchAgent
- مثيل واحد: يخرج التطبيق مبكرًا إذا كان هناك مثيل آخر يعمل بنفس معرّف الحزمة.

## ملاحظات التقسية

- يُفضَّل اشتراط تطابق TeamID لجميع الأسطح ذات الامتيازات.
- PeekabooBridge: قد يسمح `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) للمتصلين بنفس UID لأغراض التطوير المحلي.
- تظل جميع الاتصالات محلية فقط؛ لا يتم تعريض أي مقابس شبكة.
- تنشأ مطالبات TCC فقط من حزمة تطبيق واجهة المستخدم الرسومية؛ احرص على إبقاء معرّف الحزمة الموقّع ثابتًا عبر عمليات إعادة البناء.
- تقسية IPC: وضع المقبس `0600`، رمز مميّز، فحوصات UID للقرين، تحدّي/استجابة HMAC، وTTL قصير.
