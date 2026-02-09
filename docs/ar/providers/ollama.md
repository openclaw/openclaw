---
summary: "تشغيل OpenClaw باستخدام Ollama (بيئة تشغيل LLM محلية)"
read_when:
  - تريد تشغيل OpenClaw مع نماذج محلية عبر Ollama
  - تحتاج إلى إرشادات إعداد وتهيئة Ollama
title: "Ollama"
---

# Ollama

Ollama هي بيئة تشغيل LLM محلية تجعل من السهل تشغيل النماذج مفتوحة المصدر على جهازك. يتكامل OpenClaw مع واجهة Ollama البرمجية المتوافقة مع OpenAI، ويمكنه **اكتشاف النماذج القادرة على استخدام الأدوات تلقائيًا** عندما تقوم بالتمكين عبر `OLLAMA_API_KEY` (أو ملف تعريف مصادقة) ولا تقوم بتعريف إدخال `models.providers.ollama` صريحًا.

## البدء السريع

1. تثبيت Ollama: [https://ollama.ai](https://ollama.ai)

2. سحب نموذج:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. تمكين Ollama لـ OpenClaw (أي قيمة تعمل؛ Ollama لا يتطلب مفتاحًا حقيقيًا):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. استخدام نماذج Ollama:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## اكتشاف النماذج (موفّر ضمني)

عند تعيين `OLLAMA_API_KEY` (أو ملف تعريف مصادقة) وعدم تعريف `models.providers.ollama`، يقوم OpenClaw باكتشاف النماذج من مثيل Ollama المحلي على `http://127.0.0.1:11434`:

- يستعلم عن `/api/tags` و `/api/show`
- يحتفظ فقط بالنماذج التي تُبلغ عن قدرة `tools`
- يعلّم `reasoning` عندما يُبلغ النموذج عن `thinking`
- يقرأ `contextWindow` من `model_info["<arch>.context_length"]` عند توفرها
- يعيّن `maxTokens` إلى 10× نافذة السياق
- يعيّن جميع التكاليف إلى `0`

يؤدي ذلك إلى تجنّب إدخالات النماذج اليدوية مع الحفاظ على توافق الكتالوج مع قدرات Ollama.

لمعرفة النماذج المتاحة:

```bash
ollama list
openclaw models list
```

لإضافة نموذج جديد، ما عليك سوى سحبه باستخدام Ollama:

```bash
ollama pull mistral
```

سيتم اكتشاف النموذج الجديد تلقائيًا وسيكون متاحًا للاستخدام.

إذا قمت بتعيين `models.providers.ollama` بشكل صريح، فسيتم تخطي الاكتشاف التلقائي، ويجب عليك تعريف النماذج يدويًا (انظر أدناه).

## التهيئة

### الإعداد الأساسي (اكتشاف ضمني)

أسهل طريقة لتمكين Ollama هي عبر متغير البيئة:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### الإعداد الصريح (نماذج يدوية)

استخدم التهيئة الصريحة عندما:

- يعمل Ollama على مضيف/منفذ آخر.
- تريد فرض نوافذ سياق محددة أو قوائم نماذج معينة.
- تريد تضمين نماذج لا تُبلغ عن دعم الأدوات.

```json5
{
  models: {
    providers: {
      ollama: {
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

إذا تم تعيين `OLLAMA_API_KEY`، يمكنك حذف `apiKey` في إدخال الموفّر، وسيقوم OpenClaw بملئه للتحقق من التوفر.

### عنوان URL أساسي مخصص (تهيئة صريحة)

إذا كان Ollama يعمل على مضيف أو منفذ مختلف (تعطّل التهيئة الصريحة الاكتشاف التلقائي، لذا عرّف النماذج يدويًا):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

### اختيار النموذج

بمجرد التهيئة، ستكون جميع نماذج Ollama متاحة:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## متقدم

### نماذج الاستدلال

يعلّم OpenClaw النماذج على أنها قادرة على الاستدلال عندما يُبلغ Ollama عن `thinking` ضمن `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### تكاليف النماذج

Ollama مجاني ويعمل محليًا، لذلك يتم تعيين جميع تكاليف النماذج إلى ‎$0‎.

### تهيئة البث

نظرًا لوجود [مشكلة معروفة](https://github.com/badlogic/pi-mono/issues/1205) في SDK الأساسي مع تنسيق استجابة Ollama، فإن **البث مُعطّل افتراضيًا** لنماذج Ollama. يمنع ذلك الاستجابات التالفة عند استخدام نماذج قادرة على الأدوات.

عند تعطيل البث، يتم تسليم الاستجابات دفعة واحدة (وضع غير متدفق)، مما يتجنب المشكلة التي تتسبب فيها دلتا المحتوى/الاستدلال المتداخلة في إخراج مشوّه.

#### إعادة تمكين البث (متقدم)

إذا كنت ترغب في إعادة تمكين البث لـ Ollama (قد يسبب مشكلات مع النماذج القادرة على الأدوات):

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### تعطيل البث لموفّرين آخرين

يمكنك أيضًا تعطيل البث لأي موفّر إذا لزم الأمر:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

### نوافذ السياق

بالنسبة للنماذج المكتشفة تلقائيًا، يستخدم OpenClaw نافذة السياق التي يُبلغ عنها Ollama عند توفرها، وإلا فسيستخدم القيمة الافتراضية `8192`. يمكنك تجاوز `contextWindow` و `maxTokens` في تهيئة الموفّر الصريحة.

## استكشاف الأخطاء وإصلاحها

### لم يتم اكتشاف Ollama

تأكد من أن Ollama قيد التشغيل، وأنك قمت بتعيين `OLLAMA_API_KEY` (أو ملف تعريف مصادقة)، وأنك **لم** تقم بتعريف إدخال `models.providers.ollama` صريحًا:

```bash
ollama serve
```

و أن API يمكن الوصول إليه:

```bash
curl http://localhost:11434/api/tags
```

### لا توجد نماذج متاحة

يقوم OpenClaw باكتشاف النماذج تلقائيًا فقط إذا كانت تُبلغ عن دعم الأدوات. إذا لم يكن نموذجك مُدرجًا، فإما:

- اسحب نموذجًا قادرًا على الأدوات، أو
- عرّف النموذج صراحةً في `models.providers.ollama`.

لإضافة نماذج:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### تم رفض الاتصال

تحقق من أن Ollama يعمل على المنفذ الصحيح:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### استجابات تالفة أو أسماء أدوات في المخرجات

إذا رأيت استجابات مشوّهة تحتوي على أسماء أدوات (مثل `sessions_send`، `memory_get`) أو نصًا مجزأً عند استخدام نماذج Ollama، فذلك ناتج عن مشكلة في SDK أعلى السلسلة مع استجابات البث. **تم إصلاح ذلك افتراضيًا** في أحدث إصدار من OpenClaw عبر تعطيل البث لنماذج Ollama.

إذا قمت بتمكين البث يدويًا وواجهت هذه المشكلة:

1. أزل تهيئة `streaming: true` من إدخالات نماذج Ollama لديك، أو
2. عيّن `streaming: false` صراحةً لنماذج Ollama (انظر [تهيئة البث](#streaming-configuration))

## انظر أيضًا

- [موفّرو النماذج](/concepts/model-providers) - نظرة عامة على جميع الموفّرين
- [اختيار النموذج](/concepts/models) - كيفية اختيار النماذج
- [التهيئة](/gateway/configuration) - مرجع التهيئة الكامل
