---
summary: "دعم حساب Zalo الشخصي عبر zca-cli (تسجيل دخول QR)، الإمكانات، والتهيئة"
read_when:
  - إعداد Zalo Personal لـ OpenClaw
  - تصحيح أخطاء تسجيل دخول Zalo Personal أو تدفّق الرسائل
title: "Zalo Personal"
---

# Zalo Personal (غير رسمي)

الحالة: تجريبي. تقوم هذه المزايا بأتمتة **حساب Zalo شخصي** عبر `zca-cli`.

> **تحذير:** هذا تكامل غير رسمي وقد يؤدي إلى إيقاف الحساب أو حظره. استخدمه على مسؤوليتك الخاصة.

## المكوّن الإضافي المطلوب

يتم توفير Zalo Personal كمكوّن إضافي ولا يكون مُضمّنًا مع التثبيت الأساسي.

- التثبيت عبر CLI: `openclaw plugins install @openclaw/zalouser`
- أو من نسخة مصدرية: `openclaw plugins install ./extensions/zalouser`
- التفاصيل: [Plugins](/tools/plugin)

## المتطلب المسبق: zca-cli

يجب أن تحتوي آلة Gateway على الملف التنفيذي `zca` متاحًا في `PATH`.

- التحقق: `zca --version`
- إذا كان مفقودًا، ثبّت zca-cli (راجع `extensions/zalouser/README.md` أو وثائق zca-cli الرسمية).

## إعداد سريع (للمبتدئين)

1. ثبّت المكوّن الإضافي (انظر أعلاه).
2. سجّل الدخول (QR، على آلة Gateway):
   - `openclaw channels login --channel zalouser`
   - امسح رمز QR في الطرفية باستخدام تطبيق Zalo على الهاتف.
3. فعّل القناة:

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

4. أعد تشغيل Gateway (أو أنهِ التهيئة الأولية).
5. الوصول عبر الرسائل المباشرة (DM) يكون افتراضيًا عبر الإقران؛ وافق على رمز الإقران عند أول تواصل.

## ما هو

- يستخدم `zca listen` لاستقبال الرسائل الواردة.
- يستخدم `zca msg ...` لإرسال الردود (نص/وسائط/روابط).
- مُصمَّم لحالات استخدام «الحساب الشخصي» حيث لا تتوفر واجهة Zalo Bot API.

## التسمية

معرّف القناة هو `zalouser` لتوضيح أن هذا يُؤتمت **حساب مستخدم Zalo شخصي** (غير رسمي). نُبقي `zalo` محجوزًا لتكامل رسمي محتمل مع واجهة Zalo API مستقبلًا.

## العثور على المعرّفات (الدليل)

استخدم CLI الدليل لاكتشاف الأقران/المجموعات ومعرّفاتهم:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## القيود

- يتم تقسيم النص الصادر إلى مقاطع بطول ~2000 حرف (قيود عميل Zalo).
- البثّ مُعطَّل افتراضيًا.

## التحكم بالوصول (الرسائل المباشرة)

يدعم `channels.zalouser.dmPolicy`: `pairing | allowlist | open | disabled` (الافتراضي: `pairing`).
يقبل `channels.zalouser.allowFrom` معرّفات المستخدمين أو الأسماء. يقوم معالج الإعداد بتحويل الأسماء إلى معرّفات عبر `zca friend find` عند توفره.

الموافقة عبر:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## الوصول إلى المجموعات (اختياري)

- الافتراضي: `channels.zalouser.groupPolicy = "open"` (المجموعات مسموحة). استخدم `channels.defaults.groupPolicy` لتجاوز الافتراضي عند عدم الضبط.
- تقييد قائمة السماح مع:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (المفاتيح هي معرّفات المجموعات أو أسماؤها)
- حظر جميع المجموعات: `channels.zalouser.groupPolicy = "disabled"`.
- يمكن لمعالج التكوين أن يطلب قوائم السماح للمجموعة.
- عند بدء التشغيل، يقوم OpenClaw بتحويل أسماء المجموعات/المستخدمين في قوائم السماح إلى معرّفات ويُسجّل المطابقة؛ وتُحتفظ الإدخالات غير المحلولة كما كُتبت.

مثال:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## تعدد الحسابات

تُطابق الحسابات ملفات تعريف zca. مثال:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## استكشاف الأخطاء وإصلاحها

**لم يتم العثور على `zca`:**

- ثبّت zca-cli وتأكد من وجوده على `PATH` لعملية Gateway.

**تسجيل الدخول لا يستمر:**

- `openclaw channels status --probe`
- أعد تسجيل الدخول: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
