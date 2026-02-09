---
summary: "مرجع CLI لأمر `openclaw config` (الحصول/التعيين/إلغاء التعيين لقيم التهيئة)"
read_when:
  - عندما تريد قراءة التهيئة أو تحريرها بشكل غير تفاعلي
title: "التهيئة"
---

# `openclaw config`

مساعدات التهيئة: الحصول/التعيين/إلغاء التعيين للقيم حسب المسار. شغّل الأمر بدون أمر فرعي لفتح معالج الإعداد (نفس `openclaw configure`).

## أمثلة

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## المسارات

تستخدم المسارات تدوين النقطة أو الأقواس:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

استخدم فهرس قائمة الوكلاء لاستهداف وكيل محدد:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## القيم

تُحلَّل القيم كـ JSON5 عند الإمكان؛ وإلا فستُعامَل كسلاسل نصية.
استخدم `--json` لفرض تحليل JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

أعد تشغيل Gateway (البوابة) بعد إجراء التعديلات.
