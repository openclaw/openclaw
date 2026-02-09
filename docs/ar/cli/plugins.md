---
summary: "مرجع CLI لأمر `openclaw plugins` (السرد، التثبيت، التمكين/التعطيل، الفحص)"
read_when:
  - تريد تثبيت أو إدارة إضافات Gateway التي تُحمَّل داخل العملية
  - تريد تصحيح أخطاء تحميل البرنامج المساعد
title: "الإضافات"
---

# `openclaw plugins`

إدارة إضافات/امتدادات Gateway (تُحمَّل داخل العملية).

ذو صلة:

- نظام الإضافات: [Plugins](/tools/plugin)
- بيان الإضافة + المخطط: [Plugin manifest](/plugins/manifest)
- تعزيز الأمان: [Security](/gateway/security)

## الأوامر

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

تأتي الإضافات المضمّنة مع OpenClaw لكنها تبدأ معطّلة. استخدم `plugins enable` لـ
تفعيلها.

يجب على جميع الإضافات تضمين ملف `openclaw.plugin.json` مع مخطط JSON مضمن
(`configSchema`، حتى لو كان فارغًا). تؤدي البيانات الوصفية أو المخططات المفقودة/غير الصالحة إلى
منع تحميل الإضافة وفشل التحقق من التهيئة.

### التثبيت

```bash
openclaw plugins install <path-or-spec>
```

ملاحظة أمنية: تعامل مع تثبيت الإضافات كما لو كنت تُشغّل شيفرة. يُفضَّل استخدام إصدارات مُثبّتة.

الأرشيفات المدعومة: `.zip`، `.tgz`، `.tar.gz`، `.tar`.

استخدم `--link` لتجنّب نسخ دليل محلي (يُضاف إلى `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### التحديث

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

تنطبق التحديثات فقط على الإضافات المُثبّتة من npm (المتتبَّعة في `plugins.installs`).
