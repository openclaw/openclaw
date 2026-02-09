---
summary: "تشغيل OpenClaw على نماذج LLM محلية (LM Studio، vLLM، LiteLLM، ونقاط نهاية OpenAI المخصّصة)"
read_when:
  - تريد تقديم النماذج من صندوق GPU الخاص بك
  - تقوم بربط LM Studio أو وكيل متوافق مع OpenAI
  - تحتاج إلى إرشادات النماذج المحلية الأكثر أمانًا
title: "النماذج المحلية"
---

# النماذج المحلية

التشغيل المحلي ممكن، لكن OpenClaw يتوقع سياقًا كبيرًا ودفاعات قوية ضد حقن المطالبات. البطاقات الصغيرة تقطع السياق وتسرّب السلامة. استهدف مستوى عالٍ: **≥2 من أجهزة Mac Studio المُشبَعة بالكامل أو تجهيز GPU مكافئ (~30 ألف دولار+)**. تعمل بطاقة **24 غيغابايت** واحدة فقط مع مطالبات أخف وزمن استجابة أعلى. استخدم **أكبر/نسخة كاملة الحجم من النموذج يمكنك تشغيلها**؛ فالإصدارات المُكمَّمة بشدة أو «الصغيرة» تزيد مخاطر حقن المطالبات (انظر [الأمان](/gateway/security)).

## الموصى به: LM Studio + MiniMax M2.1 (Responses API، حجم كامل)

أفضل حزمة محلية حاليًا. حمّل MiniMax M2.1 في LM Studio، فعِّل الخادم المحلي (الافتراضي `http://127.0.0.1:1234`)، واستخدم Responses API لإبقاء الاستدلال منفصلًا عن النص النهائي.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**قائمة إعداد سريعة**

- ثبّت LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- في LM Studio، نزّل **أكبر إصدار متاح من MiniMax M2.1** (تجنّب الإصدارات «الصغيرة»/المكمَّمة بشدة)، ابدأ الخادم، وتأكد أن `http://127.0.0.1:1234/v1/models` يسرده.
- أبقِ النموذج محمّلًا؛ التحميل البارد يضيف زمن بدء.
- عدّل `contextWindow`/`maxTokens` إذا اختلف إصدار LM Studio لديك.
- لِـ WhatsApp، التزم بـ Responses API بحيث يُرسل النص النهائي فقط.

أبقِ النماذج المستضافة مُهيّأة حتى عند التشغيل المحلي؛ استخدم `models.mode: "merge"` لتظل البدائل الاحتياطية متاحة.

### تهيئة هجينة: مستضاف أساسي، محلي احتياطي

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### المحلي أولًا مع شبكة أمان مستضافة

بدّل ترتيب الأساسي والاحتياطي؛ أبقِ كتلة الموفّرين نفسها و `models.mode: "merge"` لتتمكن من الرجوع إلى Sonnet أو Opus عندما يتعطل الصندوق المحلي.

### الاستضافة الإقليمية / توجيه البيانات

- تتوفر أيضًا إصدارات MiniMax/Kimi/GLM المستضافة على OpenRouter مع نقاط نهاية مُثبّتة إقليميًا (مثل الاستضافة داخل الولايات المتحدة). اختر الإصدار الإقليمي هناك للحفاظ على حركة البيانات ضمن ولايتك القضائية المختارة مع الاستمرار في استخدام `models.mode: "merge"` كبدائل احتياطية لـ Anthropic/OpenAI.
- يظل المحلي فقط أقوى مسار للخصوصية؛ أما التوجيه الإقليمي المستضاف فهو حلّ وسط عندما تحتاج ميزات المزوّدين مع رغبتك في التحكم بتدفّق البيانات.

## وكلاء محليون آخرون متوافقون مع OpenAI

تعمل vLLM وLiteLLM وOAI-proxy أو البوابات المخصّصة إذا كشفت نقطة نهاية `/v1` بأسلوب OpenAI. استبدل كتلة الموفّر أعلاه بنقطة النهاية ومعرّف النموذج لديك:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

أبقِ `models.mode: "merge"` حتى تظل النماذج المستضافة متاحة كبدائل احتياطية.

## استكشاف الأخطاء وإصلاحها

- هل يستطيع Gateway الوصول إلى الوكيل؟ `curl http://127.0.0.1:1234/v1/models`. `curl http://127.0.0.1:1234/v1/models`.
- هل تم تفريغ نموذج LM Studio؟ أعد التحميل؛ البدء البارد سبب شائع للتعليق. فالبداية الباردة هي قضية "معلقة" مشتركة.
- أخطاء في السياق؟ أخطاء السياق؟ خفّض `contextWindow` أو ارفع حدّ الخادم لديك.
- السلامة: النماذج المحلية تتجاوز مرشّحات المزوّدين؛ أبقِ الوكلاء محدودين وفعّل الضغط لتقليل نصف قطر تأثير حقن المطالبات.
