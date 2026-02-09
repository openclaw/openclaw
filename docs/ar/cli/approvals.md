---
summary: "مرجع CLI لأمر `openclaw approvals` (موافقات التنفيذ لمضيف Gateway أو مضيف العُقدة)"
read_when:
  - تريد تعديل موافقات التنفيذ من خلال CLI
  - تحتاج إلى إدارة قوائم السماح على مضيف Gateway أو مضيفي العُقد
title: "الموافقات"
---

# `openclaw approvals`

إدارة موافقات التنفيذ للمضيف **المحلي**، أو **مضيف Gateway**، أو **مضيف عُقدة**.
افتراضيًا، تستهدف الأوامر ملف الموافقات المحلي على القرص. استخدم `--gateway` لاستهداف Gateway، أو `--node` لاستهداف عُقدة محددة.

ذو صلة:

- موافقات التنفيذ: [Exec approvals](/tools/exec-approvals)
- العُقد: [Nodes](/nodes)

## الأوامر الشائعة

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## استبدال الموافقات من ملف

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## مساعدات قوائم السماح

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## ملاحظات

- يستخدم `--node` نفس محلّل التعريفات مثل `openclaw nodes` (المعرّف، الاسم، عنوان IP، أو بادئة المعرّف).
- القيمة الافتراضية لـ `--agent` هي `"*"`، والتي تنطبق على جميع الوكلاء.
- يجب أن يعلن مضيف العُقدة عن `system.execApprovals.get/set` (تطبيق macOS أو مضيف عُقدة بدون واجهة).
- تُخزَّن ملفات الموافقات لكل مضيف في `~/.openclaw/exec-approvals.json`.
