---
summary: "واجهة نماذج CLI: السرد، التعيين، الأسماء المستعارة، البدائل، الفحص، الحالة"
read_when:
  - إضافة أو تعديل واجهة نماذج CLI (models list/set/scan/aliases/fallbacks)
  - تغيير سلوك بدائل النماذج أو تجربة اختيار النموذج
  - تحديث مجسّات فحص النماذج (الأدوات/الصور)
title: "واجهة نماذج CLI"
---

# واجهة نماذج CLI

انظر [/concepts/model-failover](/concepts/model-failover) لتدوير ملفات تعريف المصادقة،
وفترات التهدئة، وكيفية تفاعل ذلك مع البدائل.
نظرة عامة سريعة على الموفّرين + أمثلة: [/concepts/model-providers](/concepts/model-providers).

## كيف يعمل اختيار النموذج

يختار OpenClaw النماذج بهذا الترتيب:

1. **النموذج الأساسي** (`agents.defaults.model.primary` أو `agents.defaults.model`).
2. **البدائل** في `agents.defaults.model.fallbacks` (بالترتيب).
3. **التحويل الاحتياطي لمصادقة الموفّر** يحدث داخل الموفّر قبل الانتقال إلى
   النموذج التالي.

ذو صلة:

- `agents.defaults.models` هي قائمة السماح/الكتالوج للنماذج التي يمكن لـ OpenClaw استخدامها (مع الأسماء المستعارة).
- يُستخدم `agents.defaults.imageModel` **فقط عندما** لا يستطيع النموذج الأساسي قبول الصور.
- يمكن للإعدادات الافتراضية لكل وكيل تجاوز `agents.defaults.model` عبر `agents.list[].model` إضافةً إلى الارتباطات (انظر [/concepts/multi-agent](/concepts/multi-agent)).

## اختيارات سريعة للنماذج (انطباعية)

- **GLM**: أفضل قليلًا للبرمجة واستدعاء الأدوات.
- **MiniMax**: أفضل للكتابة والأجواء.

## معالج الإعداد (موصى به)

إذا كنت لا ترغب في تحرير التهيئة يدويًا، شغّل معالج التهيئة الأولية:

```bash
openclaw onboard
```

يمكنه إعداد النموذج + المصادقة لموفّرين شائعين، بما في ذلك **اشتراك OpenAI Code (Codex)**
(OAuth) و**Anthropic** (يُنصح بمفتاح API؛ كما يُدعم `claude
setup-token`).

## مفاتيح التهيئة (نظرة عامة)

- `agents.defaults.model.primary` و `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` و `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (قائمة السماح + الأسماء المستعارة + معلمات الموفّر)
- `models.providers` (موفّرون مخصّصون تُكتب في `models.json`)

تُوحَّد مراجع النماذج إلى أحرف صغيرة. الأسماء المستعارة للموفّرين مثل `z.ai/*`
تُوحَّد إلى `zai/*`.

أمثلة تهيئة الموفّرين (بما في ذلك OpenCode Zen) موجودة في
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## «النموذج غير مسموح به» (ولِمَ تتوقف الردود)

إذا تم تعيين `agents.defaults.models`، فسيصبح **قائمة السماح** لـ `/model` ولتجاوزات الجلسة. عندما يختار المستخدم نموذجًا غير موجود في تلك القائمة، يُرجع OpenClaw:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

يحدث هذا **قبل** إنشاء رد طبيعي، لذا قد يبدو أن الرسالة «لم تستجب». الحل هو أحد الخيارات التالية:

- إضافة النموذج إلى `agents.defaults.models`، أو
- مسح قائمة السماح (إزالة `agents.defaults.models`)، أو
- اختيار نموذج من `/model list`.

مثال على تهيئة قائمة السماح:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## تبديل النماذج في الدردشة (`/model`)

يمكنك تبديل النماذج للجلسة الحالية دون إعادة التشغيل:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

ملاحظات:

- `/model` (و`/model list`) مُنتقٍ مدمج مُرقّم (عائلة النموذج + الموفّرين المتاحين).
- `/model <#>` يختار من ذلك المُنتقِي.
- `/model status` هو العرض التفصيلي (مرشحو المصادقة، وعند التهيئة، نقطة نهاية الموفّر `baseUrl` + وضع `api`).
- تُحلَّل مراجع النماذج بتقسيمها على **أول** `/`. استخدم `provider/model` عند كتابة `/model <ref>`.
- إذا كان معرّف النموذج نفسه يحتوي على `/` (بنمط OpenRouter)، يجب تضمين بادئة الموفّر (مثال: `/model openrouter/moonshotai/kimi-k2`).
- إذا حذفت الموفّر، يتعامل OpenClaw مع الإدخال كاسم مستعار أو نموذج للموفّر **الافتراضي** (يعمل فقط عندما لا يوجد `/` في معرّف النموذج).

سلوك الأوامر/التهيئة الكامل: [أوامر الشرطة المائلة](/tools/slash-commands).

## أوامر CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (من دون أمر فرعي) هو اختصار لـ `models status`.

### `models list`

يعرض النماذج المهيأة افتراضيًا. أعلام مفيدة:

- `--all`: الكتالوج الكامل
- `--local`: موفّرون محليون فقط
- `--provider <name>`: التصفية حسب الموفّر
- `--plain`: نموذج واحد لكل سطر
- `--json`: إخراج قابل للقراءة آليًا

### `models status`

يعرض النموذج الأساسي المحسوم، والبدائل، ونموذج الصور، ونظرة عامة على المصادقة
للموفّرين المهيئين. كما يُظهر حالة انتهاء OAuth لملفات التعريف الموجودة
في مخزن المصادقة (تحذير خلال 24 ساعة افتراضيًا). يقوم `--plain` بطباعة
النموذج الأساسي المحسوم فقط.
تُعرض حالة OAuth دائمًا (ومشمولة في إخراج `--json`). إذا كان لدى موفّر
مهيأ بلا بيانات اعتماد، يطبع `models status` قسم **مصادقة مفقودة**.
يتضمن إخراج JSON `auth.oauth` (نافذة التحذير + ملفات التعريف) و`auth.providers`
(المصادقة الفعّالة لكل موفّر).
استخدم `--check` للأتمتة (رمز خروج `1` عند الفقدان/الانتهاء،
و`2` عند الاقتراب من الانتهاء).

المصادقة المفضلة لـ Anthropic هي setup-token عبر Claude Code CLI
(يمكن تشغيله في أي مكان؛ الصق الرمز على مضيف Gateway إذا لزم):

```bash
claude setup-token
openclaw models status
```

## الفحص (نماذج OpenRouter المجانية)

يقوم `openclaw models scan` بفحص **كتالوج النماذج المجانية** لدى OpenRouter ويمكنه
اختياريًا اختبار دعم الأدوات والصور.

أعلام أساسية:

- `--no-probe`: تخطي الاختبارات الحية (بيانات وصفية فقط)
- `--min-params <b>`: الحد الأدنى لحجم المعلمات (بالمليارات)
- `--max-age-days <days>`: تخطي النماذج الأقدم
- `--provider <name>`: مُرشِّح بادئة الموفّر
- `--max-candidates <n>`: حجم قائمة البدائل
- `--set-default`: تعيين `agents.defaults.model.primary` إلى أول اختيار
- `--set-image`: تعيين `agents.defaults.imageModel.primary` إلى أول اختيار للصور

يتطلب الاختبار مفتاح API لـ OpenRouter (من ملفات تعريف المصادقة أو
`OPENROUTER_API_KEY`). من دون مفتاح، استخدم `--no-probe` لسرد المرشحين فقط.

تُرتَّب نتائج الفحص حسب:

1. دعم الصور
2. زمن تأخير الأدوات
3. حجم السياق
4. عدد المعلمات

الإدخال

- قائمة OpenRouter `/models` (تصفية `:free`)
- يتطلب مفتاح API لـ OpenRouter من ملفات تعريف المصادقة أو `OPENROUTER_API_KEY` (انظر [/environment](/help/environment))
- مرشحات اختيارية: `--max-age-days`، `--min-params`، `--provider`، `--max-candidates`
- عناصر تحكم الاختبار: `--timeout`، `--concurrency`

عند التشغيل في TTY، يمكنك اختيار البدائل تفاعليًا. في الوضع غير التفاعلي،
مرّر `--yes` لقبول الإعدادات الافتراضية.

## سجل النماذج (`models.json`)

تُكتب الموفّرات المخصّصة في `models.providers` إلى `models.json` ضمن
دليل الوكيل (الافتراضي `~/.openclaw/agents/<agentId>/models.json`). يتم دمج هذا الملف افتراضيًا
ما لم يتم تعيين `models.mode` إلى `replace`.
