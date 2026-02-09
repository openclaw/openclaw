---
summary: "استخدام Anthropic Claude عبر مفاتيح API أو setup-token في OpenClaw"
read_when:
  - تريد استخدام نماذج Anthropic في OpenClaw
  - تريد استخدام setup-token بدلًا من مفاتيح API
title: "Anthropic"
---

# Anthropic (Claude)

تطوّر Anthropic عائلة نماذج **Claude** وتوفّر الوصول إليها عبر واجهة برمجة التطبيقات.
في OpenClaw يمكنك المصادقة باستخدام مفتاح API أو **setup-token**.

## الخيار A: مفتاح Anthropic API

**الأفضل لـ:** الوصول القياسي إلى API والفوترة حسب الاستخدام.
أنشئ مفتاح API الخاص بك في وحدة تحكّم Anthropic.

### إعداد CLI

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### مقتطف تهيئة

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## تخزين المطالبات مؤقتًا (Anthropic API)

يدعم OpenClaw ميزة تخزين المطالبات مؤقتًا الخاصة بـ Anthropic. هذه الميزة **مقتصرة على API فقط**؛ ولا تلتزم مصادقة الاشتراك بإعدادات التخزين المؤقت.

### التهيئة

استخدم المعامل `cacheRetention` في تهيئة النموذج:

| القيمة  | مدة التخزين المؤقت | الوصف                                               |
| ------- | ------------------ | --------------------------------------------------- |
| `none`  | لا يوجد مخبئ       | تعطيل تخزين المطالبات مؤقتًا                        |
| `short` | 5 دقائق            | الافتراضي لمصادقة مفتاح API                         |
| `long`  | ساعة واحدة         | تخزين ممتد (يتطلب علامة تجريبية) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### الإعدادات الافتراضية

عند استخدام مصادقة مفتاح Anthropic API، يطبّق OpenClaw تلقائيًا `cacheRetention: "short"` (تخزين لمدة 5 دقائق) على جميع نماذج Anthropic. يمكنك تجاوز ذلك بتعيين `cacheRetention` صراحةً في التهيئة.

### المعلمة القديمة

لا يزال المعامل الأقدم `cacheControlTtl` مدعومًا للتوافق مع الإصدارات السابقة:

- `"5m"` يُطابِق `short`
- `"1h"` يُطابِق `long`

نوصي بالانتقال إلى المعامل الجديد `cacheRetention`.

يتضمن OpenClaw علامة تجريبية `extended-cache-ttl-2025-04-11` لطلبات Anthropic API؛ احتفظ بها إذا قمت بتجاوز ترويسات الموفّر (راجع [/gateway/configuration](/gateway/configuration)).

## الخيار B: Claude setup-token

**الأفضل لـ:** استخدام اشتراك Claude الخاص بك.

### من أين تحصل على setup-token

يتم إنشاء setup-tokens بواسطة **Claude Code CLI**، وليس من وحدة تحكّم Anthropic. يمكنك تشغيله على **أي جهاز**:

```bash
claude setup-token
```

الصق الرمز في OpenClaw (المعالج: **Anthropic token (paste setup-token)**)، أو شغّله على مضيف Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

إذا أنشأت الرمز على جهاز مختلف، فقم بلصقه:

```bash
openclaw models auth paste-token --provider anthropic
```

### إعداد CLI (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### مقتطف تهيئة (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## ملاحظات

- أنشئ setup-token باستخدام `claude setup-token` ثم الصقه، أو شغّل `openclaw models auth setup-token` على مضيف Gateway.
- إذا رأيت رسالة «OAuth token refresh failed …» عند استخدام اشتراك Claude، فأعد المصادقة باستخدام setup-token. راجع [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- تفاصيل المصادقة + قواعد إعادة الاستخدام موجودة في [/concepts/oauth](/concepts/oauth).

## استكشاف الأخطاء وإصلاحها

**أخطاء 401 / الرمز أصبح غير صالح فجأة**

- قد تنتهي مصادقة اشتراك Claude أو يتم سحبها. أعد تشغيل `claude setup-token`
  والصقه على **مضيف Gateway**.
- إذا كان تسجيل دخول Claude CLI موجودًا على جهاز مختلف، فاستخدم
  `openclaw models auth paste-token --provider anthropic` على مضيف Gateway.

**لم يتم العثور على مفتاح API لموفّر "anthropic"**

- المصادقة **لكل وكيل**. الوكلاء الجدد لا يرثون مفاتيح الوكيل الرئيسي.
- أعد تشغيل التهيئة الأولية لذلك الوكيل، أو الصق setup-token / مفتاح API على
  مضيف Gateway، ثم تحقّق باستخدام `openclaw models status`.

**لم يتم العثور على بيانات اعتماد للملف الشخصي `anthropic:default`**

- شغّل `openclaw models status` لمعرفة ملف المصادقة النشط.
- أعد تشغيل التهيئة الأولية، أو الصق setup-token / مفتاح API لذلك الملف الشخصي.

**لا يوجد ملف مصادقة متاح (الكل في فترة تهدئة/غير متاح)**

- تحقّق من `openclaw models status --json` بحثًا عن `auth.unusableProfiles`.
- أضف ملف Anthropic آخر أو انتظر انتهاء فترة التهدئة.

المزيد: [/gateway/troubleshooting](/gateway/troubleshooting) و [/help/faq](/help/faq).
