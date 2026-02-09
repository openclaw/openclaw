---
summary: "مرجع CLI للأمر `openclaw onboard` (معالج تهيئة أولية تفاعلي)"
read_when:
  - عندما تريد إعدادًا موجّهًا لـ Gateway ومساحة العمل والمصادقة والقنوات وSkills
title: "onboard"
---

# `openclaw onboard`

معالج تهيئة أولية تفاعلي (إعداد Gateway محلي أو عن بُعد).

## الأدلة ذات الصلة

- مركز تهيئة CLI: [معالج التهيئة الأولية (CLI)](/start/wizard)
- مرجع تهيئة CLI: [مرجع تهيئة CLI](/start/wizard-cli-reference)
- أتمتة CLI: [أتمتة CLI](/start/wizard-cli-automation)
- التهيئة على macOS: [التهيئة الأولية (تطبيق macOS)](/start/onboarding)

## أمثلة

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

ملاحظات التدفق:

- `quickstart`: مطالبات حدّية، مع إنشاء رمز Gateway تلقائيًا.
- `manual`: مطالبات كاملة للمنفذ/الربط/المصادقة (اسم مستعار لـ `advanced`).
- أسرع بدء لأول محادثة: `openclaw dashboard` (واجهة التحكم، دون إعداد قناة).

## أوامر المتابعة الشائعة

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` لا يعني وضعًا غير تفاعلي. استخدم `--non-interactive` للبرامج النصية.
</Note>
