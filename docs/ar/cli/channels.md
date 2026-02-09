---
summary: "مرجع CLI لأمر `openclaw channels` (الحسابات، الحالة، تسجيل الدخول/الخروج، السجلات)"
read_when:
  - تريد إضافة/إزالة حسابات القنوات (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (ملحق)/Signal/iMessage)
  - تريد التحقق من حالة القناة أو تتبّع سجلات القناة
title: "القنوات"
---

# `openclaw channels`

إدارة حسابات قنوات الدردشة وحالة تشغيلها على Gateway.

مستندات ذات صلة:

- أدلة القنوات: [Channels](/channels/index)
- تهيئة Gateway: [Configuration](/gateway/configuration)

## الأوامر الشائعة

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## إضافة / إزالة الحسابات

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

نصيحة: يعرض `openclaw channels add --help` الأعلام الخاصة بكل قناة (الرمز المميّز، رمز التطبيق، مسارات signal-cli، إلخ).

## تسجيل الدخول / تسجيل الخروج (تفاعلي)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## استكشاف الأخطاء وإصلاحها

- شغّل `openclaw status --deep` لإجراء فحص عام.
- استخدم `openclaw doctor` للحصول على إصلاحات موجّهة.
- يطبع `openclaw channels list` `Claude: HTTP 403 ... user:profile` → تتطلب لقطة الاستخدام نطاق `user:profile`. استخدم `--no-usage`، أو قدّم مفتاح جلسة claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`)، أو أعد المصادقة عبر Claude Code CLI.

## فحص الإمكانات

جلب تلميحات إمكانات الموفّر (النيات/النطاقات حيثما توفرت) إضافةً إلى دعم الميزات الثابتة:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

ملاحظات:

- `--channel` اختياري؛ احذفه لسرد كل القنوات (بما في ذلك الامتدادات).
- يقبل `--target` `channel:<id>` أو معرّف قناة رقميًا خامًا، وينطبق فقط على Discord.
- تختلف الفحوصات حسب الموفّر: نيات Discord + أذونات القنوات الاختيارية؛ نطاقات Slack للبوت + المستخدم؛ أعلام بوت Telegram + webhook؛ إصدار daemon لـ Signal؛ رمز تطبيق Microsoft Teams + أدوار/نطاقات Graph (مع تعليقات حيثما كان معروفًا). القنوات التي لا تحتوي على فحوصات تُبلِغ عن `Probe: unavailable`.

## حل الأسماء إلى المعرفات

تحويل أسماء القنوات/المستخدمين إلى معرّفات باستخدام دليل الموفّر:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

ملاحظات:

- استخدم `--kind user|group|auto` لفرض نوع الهدف.
- يفضّل التحويل التطابقات النشطة عندما تشترك عدة إدخالات في الاسم نفسه.
