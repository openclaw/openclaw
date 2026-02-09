---
summary: "تدفق التهيئة الأولية عند التشغيل الأول لـ OpenClaw (تطبيق macOS)"
read_when:
  - تصميم معالج التهيئة الأولية لتطبيق macOS
  - تنفيذ إعدادات المصادقة أو الهوية
title: "التهيئة الأولية (تطبيق macOS)"
sidebarTitle: "Onboarding: macOS App"
---

# التهيئة الأولية (تطبيق macOS)

تصف هذه الوثيقة تدفق التهيئة الأولية **الحالي** عند التشغيل لأول مرة. الهدف هو
تجربة سلسة من «اليوم صفر»: اختيار مكان تشغيل Gateway (البوابة)، ربط المصادقة،
تشغيل معالج الإعداد، وترك الوكيل يهيّئ نفسه ذاتيًا.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="اقرأ إشعار الأمان المعروض واتخذ القرار وفقًا لذلك">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

أين يعمل **Gateway** (البوابة)؟

- **هذا الـ Mac (محلي فقط):** يمكن للتهيئة الأولية تشغيل تدفقات OAuth وكتابة بيانات الاعتماد محليًا.
- **بعيد (عبر SSH/Tailnet):** لا تُشغِّل التهيئة الأولية OAuth محليًا؛ يجب أن تكون بيانات الاعتماد موجودة على مضيف Gateway.
- **التهيئة لاحقًا:** تخطَّ الإعداد واترك التطبيق غير مُهيّأ.

<Tip>
**نصيحة مصادقة Gateway:**
- يولِّد المعالج الآن **رمزًا مميّزًا** حتى لـ loopback، لذا يجب على عملاء WS المحليين المصادقة.
- إذا عطّلت المصادقة، يمكن لأي عملية محلية الاتصال؛ استخدم ذلك فقط على الأجهزة الموثوقة بالكامل.
- استخدم **رمزًا مميّزًا** للوصول متعدد الأجهزة أو لعمليات الربط غير loopback.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="اختر الأذونات التي تريد منحها لـ OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

تطلب التهيئة الأولية أذونات TCC اللازمة لـ:

- الأتمتة (AppleScript)
- الإشعارات
- إمكانية الوصول
- تسجيل الشاشة
- الميكروفون
- التعرّف على الكلام
- الكاميرا
- الموقع

</Step>
<Step title="CLI">
  <Info>هذه الخطوة اختيارية</Info>
  يمكن للتطبيق تثبيت CLI العالمي `openclaw` عبر npm/pnpm بحيث تعمل
  تدفقات العمل في الطرفية ومهام launchd مباشرة دون إعداد إضافي.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  بعد الإعداد، يفتح التطبيق جلسة دردشة مخصّصة للتهيئة الأولية حتى يتمكّن الوكيل من
  تقديم نفسه وإرشاد الخطوات التالية. يحافظ ذلك على توجيه التشغيل الأول منفصلًا
  عن محادثتك العادية. راجع [Bootstrapping](/start/bootstrapping) لمعرفة ما يحدث
  على مضيف Gateway أثناء تشغيل الوكيل لأول مرة.
</Step>
</Steps>
