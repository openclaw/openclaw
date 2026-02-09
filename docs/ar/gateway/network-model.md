---
summary: "كيفية اتصال Gateway والعُقد ومضيف اللوحة."
read_when:
  - تريد عرضًا موجزًا لنموذج شبكات Gateway
title: "نموذج الشبكة"
---

تتدفق معظم العمليات عبر Gateway (`openclaw gateway`)، وهي عملية واحدة طويلة التشغيل تمتلك اتصالات القنوات ومستوى التحكّم عبر WebSocket.

## القواعد الأساسية

- يُوصى بوجود Gateway واحد لكل مضيف. وهو العملية الوحيدة المسموح لها بامتلاك جلسة WhatsApp Web. لروبوتات الإنقاذ أو العزل الصارم، شغّل عدة Gateways بملفات تعريف ومنافذ معزولة. راجع [بوابات متعددة](/gateway/multiple-gateways).
- ابدأ بـ local loopback: الإعداد الافتراضي لـ Gateway WS هو `ws://127.0.0.1:18789`. يُنشئ معالج الإعداد رمز Gateway افتراضيًا، حتى عند استخدام loopback. للوصول عبر tailnet، شغّل `openclaw gateway --bind tailnet --token ...` لأن الرموز مطلوبة لعمليات الربط غير القائمة على loopback.
- تتصل العُقد بـ Gateway WS عبر LAN أو tailnet أو SSH حسب الحاجة. جسر TCP القديم مهمل.
- مضيف اللوحة هو خادم ملفات HTTP على `canvasHost.port` (الافتراضي `18793`) يقدّم `/__openclaw__/canvas/` لواجهات WebView الخاصة بالعُقد. راجع [تهيئة Gateway](/gateway/configuration) (`canvasHost`).
- يكون الاستخدام عن بُعد عادة عبر نفق SSH أو VPN عبر tailnet. راجع [الوصول عن بُعد](/gateway/remote) و[الاكتشاف](/gateway/discovery).
