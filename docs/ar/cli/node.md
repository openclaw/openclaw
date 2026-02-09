---
summary: "مرجع CLI للأمر `openclaw node` (مضيف عُقدة بدون واجهة)"
read_when:
  - تشغيل مضيف العُقدة بدون واجهة
  - إقران عُقدة غير macOS لاستخدام system.run
title: "عقدة"
---

# `openclaw node`

شغّل **مضيف عُقدة بدون واجهة** يتصل بـ WebSocket الخاص بـ Gateway ويكشف
`system.run` / `system.which` على هذا الجهاز.

## لماذا استخدام مضيف عُقدة؟

استخدم مضيف العُقدة عندما تريد من الوكلاء **تشغيل أوامر على أجهزة أخرى** ضمن
شبكتك دون تثبيت تطبيق مرافق كامل لنظام macOS هناك.

حالات الاستخدام الشائعة:

- تشغيل أوامر على أجهزة Linux/Windows بعيدة (خوادم بناء، أجهزة مختبر، NAS).
- إبقاء التنفيذ **sandboxed** على الـ Gateway، مع تفويض عمليات التشغيل المعتمدة إلى مضيفين آخرين.
- توفير هدف تنفيذ خفيف وبدون واجهة لأتمتة المهام أو لعُقد CI.

لا يزال التنفيذ محميًا عبر **موافقات exec** وقوائم السماح لكل وكيل على مضيف العُقدة،
وبذلك يمكنك إبقاء الوصول إلى الأوامر محددًا وواضحًا.

## وكيل المتصفح (بدون تهيئة)

تعلن مضيفات العُقد تلقائيًا عن وكيل متصفح إذا لم يكن `browser.enabled` معطّلًا
على العُقدة. يتيح ذلك للوكيل استخدام أتمتة المتصفح على تلك العُقدة دون تهيئة إضافية.

قم بتعطيله على العقدة إذا لزم الأمر:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## التشغيل (في الواجهة الأمامية)

```bash
openclaw node run --host <gateway-host> --port 18789
```

الخيارات:

- `--host <host>`: مضيف WebSocket الخاص بـ Gateway (الافتراضي: `127.0.0.1`)
- `--port <port>`: منفذ WebSocket الخاص بـ Gateway (الافتراضي: `18789`)
- `--tls`: استخدام TLS لاتصال الـ Gateway
- `--tls-fingerprint <sha256>`: بصمة شهادة TLS المتوقعة (sha256)
- `--node-id <id>`: تجاوز مُعرّف العُقدة (يمسح رمز الإقران)
- `--display-name <name>`: تجاوز اسم عرض العُقدة

## الخدمة (في الخلفية)

تثبيت مضيف عقدة بلا رأس كخدمة مستخدم.

```bash
openclaw node install --host <gateway-host> --port 18789
```

الخيارات:

- `--host <host>`: مضيف WebSocket الخاص بـ Gateway (الافتراضي: `127.0.0.1`)
- `--port <port>`: منفذ WebSocket الخاص بـ Gateway (الافتراضي: `18789`)
- `--tls`: استخدام TLS لاتصال الـ Gateway
- `--tls-fingerprint <sha256>`: بصمة شهادة TLS المتوقعة (sha256)
- `--node-id <id>`: تجاوز مُعرّف العُقدة (يمسح رمز الإقران)
- `--display-name <name>`: تجاوز اسم عرض العُقدة
- `--runtime <runtime>`: بيئة تشغيل الخدمة (`node` أو `bun`)
- `--force`: إعادة التثبيت/الاستبدال إذا كانت مثبتة بالفعل

إدارة الخدمة:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

استخدم `openclaw node run` لمضيف عُقدة يعمل في الواجهة الأمامية (بدون خدمة).

تقبل أوامر الخدمة `--json` لإخراج قابل للقراءة آليًا.

## الإقران

ينشئ الاتصال الأول طلب إقران عُقدة قيد الانتظار على الـ Gateway.
وافِق عليه عبر:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

يخزّن مضيف العُقدة مُعرّف العُقدة والرمز واسم العرض ومعلومات اتصال الـ Gateway في
`~/.openclaw/node.json`.

## موافقات التنفيذ

`system.run` مُقيّد بموافقات تنفيذ محلية:

- `~/.openclaw/exec-approvals.json`
- [موافقات التنفيذ](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (تحرير من الـ Gateway)
