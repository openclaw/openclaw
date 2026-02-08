---
summary: "مرجع CLI لأمر `openclaw doctor` (فحوصات السلامة + إصلاحات مُوجَّهة)"
read_when:
  - لديك مشكلات في الاتصال/المصادقة وتريد إصلاحات مُوجَّهة
  - قمت بالتحديث وتريد إجراء فحص سلامة
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:57Z
---

# `openclaw doctor`

فحوصات السلامة + إصلاحات سريعة لـ Gateway والقنوات.

ذو صلة:

- استكشاف الأخطاء وإصلاحها: [استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting)
- التدقيق الأمني: [الأمان](/gateway/security)

## أمثلة

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

ملاحظات:

- تعمل المطالبات التفاعلية (مثل إصلاحات keychain/OAuth) فقط عندما يكون stdin عبارة عن TTY ولم يتم تعيين `--non-interactive`. عمليات التشغيل بدون واجهة (cron، Telegram، بدون طرفية) ستتخطى المطالبات.
- يقوم `--fix` (اسم بديل لـ `--repair`) بكتابة نسخة احتياطية إلى `~/.openclaw/openclaw.json.bak` وحذف مفاتيح التهيئة غير المعروفة، مع سرد كل عملية إزالة.

## macOS: تجاوزات متغيرات البيئة `launchctl`

إذا كنت قد شغّلت سابقًا `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (أو `...PASSWORD`)، فإن تلك القيمة تتجاوز ملف التهيئة لديك وقد تتسبب في أخطاء «غير مُخوَّل» مستمرة.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
