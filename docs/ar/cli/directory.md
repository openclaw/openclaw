---
summary: "مرجع CLI لأمر `openclaw directory` (الذات، الأقران، المجموعات)"
read_when:
  - تريد البحث عن معرّفات جهات الاتصال/المجموعات/الذات لقناة ما
  - تقوم بتطوير مُحوّل دليل قناة
title: "directory"
---

# `openclaw directory`

عمليات البحث في الدليل للقنوات التي تدعم ذلك (جهات الاتصال/الأقران، المجموعات، و«أنا»).

## الأعلام الشائعة

- `--channel <name>`: معرّف/اسم مستعار للقناة (مطلوب عند تهيئة عدة قنوات؛ تلقائي عند تهيئة قناة واحدة فقط)
- `--account <id>`: معرّف الحساب (الافتراضي: الافتراضي للقناة)
- `--json`: إخراج JSON

## ملاحظات

- `directory` مُصمَّم لمساعدتك في العثور على المعرّفات التي يمكنك لصقها في أوامر أخرى (خصوصًا `openclaw message send --target ...`).
- بالنسبة للعديد من القنوات، تكون النتائج مدعومة بالتهيئة (قوائم السماح / المجموعات المُهيّأة) بدلًا من دليل الموفّر المباشر.
- الإخراج الافتراضي هو `id` (وأحيانًا `name`) مفصولان بعلامة تبويب؛ استخدم `--json` لأغراض البرمجة النصية.

## استخدام النتائج مع `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## صيغ المعرّفات (حسب القناة)

- WhatsApp: `+15551234567` (رسالة مباشرة)، `1234567890-1234567890@g.us` (مجموعة)
- Telegram: `@username` أو معرّف محادثة رقمي؛ المجموعات هي معرّفات رقمية
- Slack: `user:U…` و `channel:C…`
- Discord: `user:<id>` و `channel:<id>`
- Matrix (إضافة): `user:@user:server`، `room:!roomId:server`، أو `#alias:server`
- Microsoft Teams (إضافة): `user:<id>` و `conversation:<id>`
- Zalo (إضافة): معرّف المستخدم (Bot API)
- Zalo Personal / `zalouser` (إضافة): معرّف السلسلة (رسالة مباشرة/مجموعة) من `zca` (`me`، `friend list`، `group list`)

## الذات («أنا»)

```bash
openclaw directory self --channel zalouser
```

## الأقران (جهات الاتصال/المستخدمون)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## المجموعات

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
