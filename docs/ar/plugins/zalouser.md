---
summary: "إضافة Zalo Personal: تسجيل الدخول عبر QR + المراسلة عبر zca-cli (تثبيت الإضافة + تهيئة القناة + CLI + الأداة)"
read_when:
  - تريد دعم Zalo Personal (غير رسمي) في OpenClaw
  - تقوم بتهيئة أو تطوير إضافة zalouser
title: "إضافة Zalo Personal"
---

# Zalo Personal (إضافة)

دعم Zalo Personal لـ OpenClaw عبر إضافة، باستخدام `zca-cli` لأتمتة حساب مستخدم Zalo عادي.

> **تحذير:** قد تؤدي الأتمتة غير الرسمية إلى تعليق الحساب أو حظره. استخدمه على مسؤوليتك الخاصة.

## التسمية

معرّف القناة هو `zalouser` لجعل الأمر واضحًا بأن هذا يُؤتمت **حساب مستخدم Zalo شخصي** (غير رسمي). نُبقي `zalo` محجوزًا لتكامل محتمل مستقبلاً مع واجهة Zalo API الرسمية.

## أين يتم التشغيل

تعمل هذه الإضافة **داخل عملية Gateway**.

إذا كنت تستخدم Gateway عن بُعد، فقم بتثبيتها وتهيئتها على **الجهاز الذي يشغّل Gateway**، ثم أعد تشغيل Gateway.

## التثبيت

### الخيار A: التثبيت من npm

```bash
openclaw plugins install @openclaw/zalouser
```

أعد تشغيل Gateway بعد ذلك.

### الخيار B: التثبيت من مجلد محلي (للتطوير)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

أعد تشغيل Gateway بعد ذلك.

## المتطلب المسبق: zca-cli

يجب أن يحتوي جهاز Gateway على `zca` على `PATH`:

```bash
zca --version
```

## التهيئة

توجد تهيئة القناة ضمن `channels.zalouser` (وليس `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## أداة الوكيل

اسم الأداة: `zalouser`

الإجراءات: `send`، `image`، `link`، `friends`، `groups`، `me`، `status`
