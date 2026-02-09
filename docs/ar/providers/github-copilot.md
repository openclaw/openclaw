---
summary: "تسجيل الدخول إلى GitHub Copilot من OpenClaw باستخدام تدفّق الجهاز"
read_when:
  - تريد استخدام GitHub Copilot كمزوّد نموذج
  - تحتاج إلى تدفّق `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## ما هو GitHub Copilot؟

GitHub Copilot هو مساعد البرمجة بالذكاء الاصطناعي من GitHub. يوفّر الوصول إلى
نماذج Copilot لحساب GitHub الخاص بك وخطتك. يمكن لـ OpenClaw استخدام Copilot
كمزوّد نموذج بطريقتين مختلفتين.

## طريقتان لاستخدام Copilot في OpenClaw

### 1. موفّر GitHub Copilot المدمج (`github-copilot`)

استخدم تدفّق تسجيل الدخول الأصلي عبر الجهاز للحصول على رمز GitHub، ثم استبداله
برموز واجهة برمجة تطبيقات Copilot عند تشغيل OpenClaw. هذا هو المسار **الافتراضي**
والأبسط لأنه لا يتطلّب VS Code.

### 2. إضافة Copilot Proxy (`copilot-proxy`)

استخدم إضافة VS Code المسماة **Copilot Proxy** كجسر محلي. يتواصل OpenClaw مع
نقطة نهاية `/v1` الخاصة بالوكيل ويستخدم قائمة النماذج التي تهيئها هناك. اختر هذا الخيار عندما تكون بالفعل تشغّل Copilot Proxy في VS Code أو تحتاج إلى
التوجيه عبره.
يجب تمكين الإضافة والإبقاء على إضافة VS Code قيد التشغيل.

استخدم GitHub Copilot كمزوّد نموذج (`github-copilot`). يشغّل أمر تسجيل الدخول
تدفّق جهاز GitHub، ويحفظ ملف تعريف مصادقة، ويحدّث التهيئة لاستخدام ذلك الملف.

## إعداد CLI

```bash
openclaw models auth login-github-copilot
```

سيُطلب منك زيارة عنوان URL وإدخال رمز لمرة واحدة. أبقِ الطرفية مفتوحة حتى يكتمل
الإجراء.

### أعلام اختيارية

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## تعيين نموذج افتراضي

```bash
openclaw models set github-copilot/gpt-4o
```

### مقتطف تهيئة

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## ملاحظات

- يتطلّب TTY تفاعليًا؛ شغّله مباشرةً في طرفية.
- يعتمد توفّر نماذج Copilot على خطتك؛ إذا تم رفض نموذج، جرّب معرّفًا آخر
  (على سبيل المثال `github-copilot/gpt-4.1`).
- يخزّن تسجيل الدخول رمز GitHub في مخزن ملفات تعريف المصادقة ويستبدله برمز واجهة
  برمجة تطبيقات Copilot عند تشغيل OpenClaw.
