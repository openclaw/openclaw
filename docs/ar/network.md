---
summary: "مركز الشبكة: أسطح Gateway، والاقتران، والاكتشاف، والأمان"
read_when:
  - تحتاج إلى نظرة عامة على بنية الشبكة والأمان
  - تقوم باستكشاف أخطاء الوصول المحلي مقابل الوصول عبر tailnet أو الاقتران
  - تريد القائمة المرجعية لوثائق الشبكات
title: "الشبكة"
---

# مركز الشبكة

يربط هذا المركز الوثائق الأساسية لكيفية اتصال OpenClaw واقترانه وتأمينه
للأجهزة عبر localhost وLAN وtailnet.

## النموذج الأساسي

- [بنية Gateway](/concepts/architecture)
- [بروتوكول Gateway](/gateway/protocol)
- [دليل تشغيل Gateway](/gateway)
- [أسطح الويب + أوضاع الربط](/web)

## الاقتران + الهوية

- [نظرة عامة على الاقتران (DM + العُقد)](/channels/pairing)
- [اقتران العُقد المملوكة لـ Gateway](/gateway/pairing)
- [CLI للأجهزة (الاقتران + تدوير الرموز)](/cli/devices)
- [CLI للاقران (موافقات DM)](/cli/pairing)

الثقة المحلية:

- يمكن الموافقة تلقائيًا على الاتصالات المحلية (loopback أو عنوان tailnet الخاص بمضيف Gateway)
  للاقران، للحفاظ على سلاسة تجربة المستخدم على نفس المضيف.
- لا يزال عملاء tailnet/LAN غير المحليين يتطلبون موافقة اقتران صريحة.

## الاكتشاف + وسائل النقل

- [الاكتشاف ووسائل النقل](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [الوصول عن بُعد (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## العُقد + وسائل النقل

- [نظرة عامة على العُقد](/nodes)
- [بروتوكول الجسر (العُقد القديمة)](/gateway/bridge-protocol)
- [دليل تشغيل العُقد: iOS](/platforms/ios)
- [دليل تشغيل العُقد: Android](/platforms/android)

## الأمان

- [نظرة عامة على الأمان](/gateway/security)
- [مرجع تهيئة Gateway](/gateway/configuration)
- [استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
