---
summary: "مرجع CLI لأمر `openclaw nodes` (list/status/approve/invoke، الكاميرا/اللوحة/الشاشة)"
read_when:
  - أنت تدير عُقدًا مقترنة (كاميرات، شاشة، لوحة)
  - تحتاج إلى الموافقة على الطلبات أو استدعاء أوامر العُقد
title: "nodes"
---

# `openclaw nodes`

إدارة العُقد المقترنة (الأجهزة) واستدعاء قدرات العُقد.

ذات صلة:

- نظرة عامة على العُقد: [Nodes](/nodes)
- الكاميرا: [Camera nodes](/nodes/camera)
- الصور: [Image nodes](/nodes/images)

الخيارات الشائعة:

- `--url`، `--token`، `--timeout`، `--json`

## الأوامر الشائعة

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` يطبع جداول العُقد المعلّقة/المقترنة. تتضمن الصفوف المقترنة أحدث عمر اتصال (Last Connect).
استخدم `--connected` لعرض العُقد المتصلة حاليًا فقط. استخدم `--last-connected <duration>` لـ
التصفية إلى العُقد التي اتصلت خلال مدة زمنية (مثلًا `24h`، `7d`).

## الاستدعاء / التشغيل

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

أعلام الاستدعاء:

- `--params <json>`: سلسلة كائن JSON (الافتراضي `{}`).
- `--invoke-timeout <ms>`: مهلة استدعاء العُقدة (الافتراضي `15000`).
- `--idempotency-key <key>`: مفتاح قابلية التكرار (idempotency) اختياري.

### افتراضيات نمط التنفيذ (Exec)

`nodes run` يعكس سلوك التنفيذ الخاص بالنموذج (الافتراضيات + الموافقات):

- يقرأ `tools.exec.*` (بالإضافة إلى تجاوزات `agents.list[].tools.exec.*`).
- يستخدم موافقات التنفيذ (`exec.approval.request`) قبل استدعاء `system.run`.
- يمكن إغفال `--node` عند تعيين `tools.exec.node`.
- يتطلب عُقدة تُعلن `system.run` (تطبيق مُرافِق على macOS أو مضيف عُقدة دون واجهة).

الأعلام:

- `--cwd <path>`: دليل العمل.
- `--env <key=val>`: تجاوز متغيرات البيئة (قابل للتكرار).
- `--command-timeout <ms>`: مهلة الأمر.
- `--invoke-timeout <ms>`: مهلة استدعاء العُقدة (الافتراضي `30000`).
- `--needs-screen-recording`: يتطلب إذن تسجيل الشاشة.
- `--raw <command>`: تشغيل سلسلة صدفة (`/bin/sh -lc` أو `cmd.exe /c`).
- `--agent <id>`: موافقات/قوائم سماح بنطاق الوكيل (الافتراضي إلى الوكيل المُهيأ).
- `--ask <off|on-miss|always>`، `--security <deny|allowlist|full>`: تجاوزات.
