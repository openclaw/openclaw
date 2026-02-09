---
summary: "مركز استضافة VPS لـ OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - تريد تشغيل Gateway في السحابة
  - تحتاج إلى خريطة سريعة لأدلة VPS/الاستضافة
title: "استضافة VPS"
---

# استضافة VPS

يربط هذا المركز بأدلة VPS/الاستضافة المدعومة ويشرح على مستوى عالٍ كيفية عمل
عمليات النشر السحابية.

## اختر موفّرًا

- **Railway** (نقرة واحدة + إعداد عبر المتصفح): [Railway](/install/railway)
- **Northflank** (نقرة واحدة + إعداد عبر المتصفح): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — 0 دولار/شهريًا (Always Free، ARM؛ قد تكون السعة/التسجيل متقلّبة)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (آلة افتراضية + وكيل HTTPS): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: يعمل بشكل جيّد أيضًا. دليل فيديو:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## كيف تعمل الإعدادات السحابية

- يعمل **Gateway على الـ VPS** ويمتلك الحالة + مساحة العمل.
- تتصل من حاسوبك المحمول/هاتفك عبر **واجهة التحكم** أو **Tailscale/SSH**.
- اعتبر الـ VPS مصدر الحقيقة وقم **بالنسخ الاحتياطي** للحالة + مساحة العمل.
- الإعداد الآمن افتراضيًا: أبقِ Gateway على local loopback وادخل إليه عبر نفق SSH أو Tailscale Serve.
  إذا قمت بالربط إلى `lan`/`tailnet`، فاشترط `gateway.auth.token` أو `gateway.auth.password`.

الوصول عن بُعد: [Gateway remote](/gateway/remote)  
مركز المنصّات: [Platforms](/platforms)

## استخدام العُقد مع VPS

يمكنك إبقاء Gateway في السحابة وإقرانه مع **عُقد** على أجهزتك المحلية
(Mac/iOS/Android/بدون واجهة). توفّر العُقد إمكانات الشاشة/الكاميرا/اللوحة المحلية
وقدرات `system.run` بينما يبقى Gateway في السحابة.

المستندات: [Nodes](/nodes)، [Nodes CLI](/cli/nodes)
