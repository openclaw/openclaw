---
summary: "نظرة عامة على دعم المنصات (Gateway + التطبيقات المُرافِقة)"
read_when:
  - البحث عن دعم أنظمة التشغيل أو مسارات التثبيت
  - اتخاذ قرار بشأن مكان تشغيل Gateway
title: "المنصات"
---

# المنصات

نواة OpenClaw مكتوبة بلغة TypeScript. **Node هو وقت التشغيل الموصى به**.
لا يُنصح باستخدام Bun مع Gateway (مشكلات في WhatsApp/Telegram).

توجد تطبيقات مُرافِقة لأنظمة macOS (تطبيق شريط القوائم) والعُقد المحمولة (iOS/Android). تطبيقات مُرافِقة لأنظمة Windows وLinux مخططة، لكن Gateway مدعوم بالكامل اليوم.
كما تُخطَّط تطبيقات مُرافِقة أصلية لـ Windows؛ ويُوصى بتشغيل Gateway عبر WSL2.

## اختر نظام التشغيل

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS والاستضافة

- محور VPS: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + وكيل HTTPS): [exe.dev](/install/exe-dev)

## روابط شائعة

- دليل التثبيت: [بدء الاستخدام](/start/getting-started)
- دليل تشغيل Gateway: [Gateway](/gateway)
- تهيئة Gateway: [التهيئة](/gateway/configuration)
- حالة الخدمة: `openclaw gateway status`

## تثبيت خدمة Gateway (CLI)

استخدم أحد الخيارات التالية (جميعها مدعومة):

- المعالج (موصى به): `openclaw onboard --install-daemon`
- مباشر: `openclaw gateway install`
- تدفّق التهيئة: `openclaw configure` → اختر **خدمة Gateway**
- الإصلاح/الترحيل: `openclaw doctor` (يقدّم خيار تثبيت الخدمة أو إصلاحها)

يعتمد هدف الخدمة على نظام التشغيل:

- macOS: LaunchAgent (`bot.molt.gateway` أو `bot.molt.<profile>`؛ القديم `com.openclaw.*`)
- Linux/WSL2: خدمة مستخدم systemd (`openclaw-gateway[-<profile>].service`)
