---
summary: "الوصول إلى لوحة تحكم Gateway (واجهة التحكم) والمصادقة"
read_when:
  - تغيير أوضاع مصادقة لوحة التحكم أو تعريضها
title: "لوحة التحكم"
---

# لوحة التحكم (واجهة التحكم)

لوحة تحكم Gateway هي واجهة التحكم عبر المتصفح التي تُقدَّم افتراضيًا على `/`
(يمكن تجاوز ذلك باستخدام `gateway.controlUi.basePath`).

فتح سريع (Gateway محلي):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (أو [http://localhost:18789/](http://localhost:18789/))

مراجع أساسية:

- [واجهة التحكم](/web/control-ui) للاستخدام وإمكانات الواجهة.
- [Tailscale](/gateway/tailscale) لأتمتة Serve/Funnel.
- [واجهات الويب](/web) لأوضاع الربط وملاحظات الأمان.

تُفرَض المصادقة عند مصافحة WebSocket عبر `connect.params.auth`
(رمز مميّز أو كلمة مرور). راجع `gateway.auth` في [تهيئة Gateway](/gateway/configuration).

ملاحظة أمنية: واجهة التحكم هي **سطح إداري** (دردشة، تهيئة، موافقات التنفيذ).
لا تُعرِّضها للعامة. تقوم الواجهة بتخزين الرمز المميّز في `localStorage` بعد التحميل الأول.
يُفضَّل استخدام localhost أو Tailscale Serve أو نفق SSH.

## المسار السريع (مُوصى به)

- بعد التهيئة الأولية، يقوم CLI بفتح لوحة التحكم تلقائيًا ويطبع رابطًا نظيفًا (غير مُضمَّن برمز).
- إعادة الفتح في أي وقت: `openclaw dashboard` (ينسخ الرابط، ويفتح المتصفح إن أمكن، ويعرض تلميح SSH إذا كان بدون واجهة).
- إذا طلبت الواجهة المصادقة، الصق الرمز من `gateway.auth.token` (أو `OPENCLAW_GATEWAY_TOKEN`) في إعدادات واجهة التحكم.

## أساسيات الرمز المميز (محلي مقابل إزالة)

- **Localhost**: افتح `http://127.0.0.1:18789/`.
- **مصدر الرمز**: `gateway.auth.token` (أو `OPENCLAW_GATEWAY_TOKEN`)؛ تقوم الواجهة بتخزين نسخة في localStorage بعد الاتصال.
- **ليس localhost**: استخدم Tailscale Serve (بدون رمز إذا `gateway.auth.allowTailscale: true`)، أو ربط tailnet مع رمز، أو نفق SSH. راجع [واجهات الويب](/web).

## إذا ظهرت رسالة «unauthorized» / 1008

- تأكّد من إمكانية الوصول إلى Gateway (محليًا: `openclaw status`؛ عن بُعد: نفق SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` ثم افتح `http://127.0.0.1:18789/`).
- استرجِع الرمز من مضيف Gateway: `openclaw config get gateway.auth.token` (أو أنشئ واحدًا: `openclaw doctor --generate-gateway-token`).
- في إعدادات لوحة التحكم، الصق الرمز في حقل المصادقة، ثم اتصل.
