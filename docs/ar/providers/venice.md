---
summary: "استخدم نماذج Venice AI المُركّزة على الخصوصية في OpenClaw"
read_when:
  - تريد استدلالًا مُركّزًا على الخصوصية في OpenClaw
  - تريد إرشادات إعداد Venice AI
title: "Venice AI"
---

# Venice AI (تمييز Venice)

**Venice** هي إعداد Venice المميّز لدينا للاستدلال الذي يضع الخصوصية أولًا، مع إمكانية الوصول المُجهّل الاختياري إلى نماذج احتكارية.

توفّر Venice AI استدلال ذكاء اصطناعي مُركّزًا على الخصوصية مع دعم النماذج غير الخاضعة للرقابة وإمكانية الوصول إلى النماذج الاحتكارية الرئيسية عبر وكيلها المُجهّل. جميع عمليات الاستدلال خاصة افتراضيًا — لا تدريب على بياناتك ولا تسجيل.

## لماذا Venice في OpenClaw

- **استدلال خاص** لنماذج مفتوحة المصدر (من دون تسجيل).
- **نماذج غير خاضعة للرقابة** عند الحاجة.
- **وصول مُجهّل** إلى النماذج الاحتكارية (Opus/GPT/Gemini) عندما تكون الجودة مهمة.
- نقاط نهاية متوافقة مع OpenAI `/v1`.

## أوضاع الخصوصية

تقدّم Venice مستويين من الخصوصية — فهمهما أساسي لاختيار النموذج المناسب:

| الوضع      | الوصف                                                                                                                                               | النماذج                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **خاص**    | خاص بالكامل. **لا يتم أبدًا تخزين أو تسجيل** المطالبات/الاستجابات. مؤقّت.                           | Llama، Qwen، DeepSeek، Venice Uncensored، إلخ |
| **مُجهّل** | يمر عبر Venice مع إزالة البيانات الوصفية. يرى المزوّد الأساسي (OpenAI، Anthropic) طلبات مُجهّلة. | Claude، GPT، Gemini، Grok، Kimi، MiniMax      |

## الميزات

- **التركيز على الخصوصية**: اختر بين وضع «خاص» (خاص بالكامل) و«مُجهّل» (عبر وكيل)
- **نماذج غير خاضعة للرقابة**: الوصول إلى نماذج بلا قيود محتوى
- **الوصول إلى نماذج كبرى**: استخدم Claude وGPT-5.2 وGemini وGrok عبر وكيل Venice المُجهّل
- **واجهة برمجة متوافقة مع OpenAI**: نقاط نهاية قياسية `/v1` لسهولة التكامل
- **البث**: ✅ مدعوم على جميع النماذج
- **استدعاء الدوال**: ✅ مدعوم على نماذج محددة (تحقق من قدرات النموذج)
- **الرؤية**: ✅ مدعومة على النماذج التي تملك قدرات رؤية
- **لا حدود صارمة للمعدّل**: قد يُطبّق تقييد الاستخدام العادل عند الاستعمال المفرط

## الإعداد

### 1. الحصول على مفتاح API

1. سجّل في [venice.ai](https://venice.ai)
2. انتقل إلى **Settings → API Keys → Create new key**
3. انسخ مفتاح API الخاص بك (الصيغة: `vapi_xxxxxxxxxxxx`)

### 2) تهيئة OpenClaw

**الخيار A: متغير بيئة**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**الخيار B: إعداد تفاعلي (موصى به)**

```bash
openclaw onboard --auth-choice venice-api-key
```

سيقوم هذا بما يلي:

1. طلب مفتاح API الخاص بك (أو استخدام `VENICE_API_KEY` الموجود)
2. عرض جميع نماذج Venice المتاحة
3. السماح لك باختيار النموذج الافتراضي
4. تهيئة المزوّد تلقائيًا

**الخيار C: غير تفاعلي**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. التحقق من الإعداد

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## اختيار النموذج

بعد الإعداد، يعرض OpenClaw جميع نماذج Venice المتاحة. اختر بناءً على احتياجاتك:

- **الافتراضي (اختيارنا)**: `venice/llama-3.3-70b` لأداء متوازن وخاص.
- **أفضل جودة إجمالية**: `venice/claude-opus-45` للمهام الصعبة (لا يزال Opus الأقوى).
- **الخصوصية**: اختر نماذج «خاص» لاستدلال خاص بالكامل.
- **القدرات**: اختر نماذج «مُجهّل» للوصول إلى Claude وGPT وGemini عبر وكيل Venice.

غيّر النموذج الافتراضي في أي وقت:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

عرض جميع النماذج المتاحة:

```bash
openclaw models list | grep venice
```

## التهيئة عبر `openclaw configure`

1. شغّل `openclaw configure`
2. اختر **Model/auth**
3. اختر **Venice AI**

## أي نموذج يجب أن أستخدم؟

| حالة الاستخدام           | النموذج الموصى به                | لماذا                               |
| ------------------------ | -------------------------------- | ----------------------------------- |
| **دردشة عامة**           | `llama-3.3-70b`                  | جيّد في كل شيء، خاص بالكامل         |
| **أفضل جودة إجمالية**    | `claude-opus-45`                 | لا يزال Opus الأقوى للمهام الصعبة   |
| **خصوصية + جودة Claude** | `claude-opus-45`                 | أفضل منطق عن طريق وكيل مجهول الهوية |
| **البرمجة**              | `qwen3-coder-480b-a35b-instruct` | مُحسّن للشفرة، سياق 262k            |
| **مهام الرؤية**          | `qwen3-vl-235b-a22b`             | أفضل نموذج رؤية خاص                 |
| **غير خاضع للرقابة**     | `venice-uncensored`              | بلا قيود محتوى                      |
| **سريع ورخيص**           | `qwen3-4b`                       | خفيف الوزن، وما يزال قادرًا         |
| **استدلال معقّد**        | `deepseek-v3.2`                  | استدلال قوي، خاص                    |

## النماذج المتاحة (25 إجمالًا)

### نماذج خاصة (15) — خاصة بالكامل، بلا تسجيل

| معرف النموذج                     | الاسم                                      | السياق (رموز) | الميزات               |
| -------------------------------- | ------------------------------------------ | -------------------------------- | --------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                             | عام                   |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                             | سريع، خفيف            |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                             | مهام معقّدة           |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                             | استدلال               |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                             | عام                   |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                             | الشيفرة               |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                             | عام                   |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                             | رؤية                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                              | سريع، استدلال         |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                             | استدلال               |
| `venice-uncensored`              | Venice Uncensored                          | 32k                              | بدون رقابة            |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                             | رؤية                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                             | رؤية                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                             | عام                   |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                             | استدلال، متعدد اللغات |

### نماذج مُجهّلة (10) — عبر وكيل Venice

| معرف النموذج             | الأصل                             | السياق (رموز) | الميزات        |
| ------------------------ | --------------------------------- | -------------------------------- | -------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                             | استدلال، رؤية  |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                             | استدلال، رؤية  |
| `openai-gpt-52`          | GPT-5.2           | 262k                             | استدلال        |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                             | استدلال، رؤية  |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                             | استدلال، رؤية  |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                             | استدلال، رؤية  |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                             | استدلال، رؤية  |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                             | استدلال، برمجة |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                             | استدلال        |
| `minimax-m21`            | MiniMax M2.1      | 202k                             | استدلال        |

## اكتشاف النماذج

يكتشف OpenClaw النماذج تلقائيًا من واجهة Venice API عند تعيين `VENICE_API_KEY`. إذا تعذّر الوصول إلى واجهة API، يعود إلى كتالوج ثابت.

نقطة النهاية `/models` عامة (لا تتطلب مصادقة للعرض)، لكن الاستدلال يتطلب مفتاح API صالحًا.

## البث ودعم الأدوات

| الميزة             | الدعم                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| **البث**           | ✅ جميع النماذج                                                                     |
| **استدعاء الدوال** | ✅ معظم النماذج (تحقق من `supportsFunctionCalling` في واجهة API) |
| **الرؤية/الصور**   | ✅ النماذج الموسومة بميزة «Vision»                                                  |
| **وضع JSON**       | ✅ مدعوم عبر `response_format`                                                      |

## التسعير

تستخدم Venice نظامًا قائمًا على الأرصدة. تحقّق من [venice.ai/pricing](https://venice.ai/pricing) للأسعار الحالية:

- **النماذج الخاصة**: عادةً أقل تكلفة
- **النماذج المُجهّلة**: مماثلة لتسعير واجهة API المباشرة + رسم صغير لـ Venice

## مقارنة: Venice مقابل واجهة API المباشرة

| الجانب       | Venice (مُجهّل)      | واجهة API المباشرة |
| ------------ | --------------------------------------- | ------------------ |
| **الخصوصية** | تم تجريد البيانات الوصفية، مجهول الهوية | حسابك مرتبط        |
| **الكمون**   | +10-50مل (وكيل)      | مباشر              |
| **الميزات**  | معظم الميزات مدعومة                     | جميع الميزات       |
| **الفوترة**  | أرصدة Venice                            | فوترة المزوّد      |

## أمثلة الاستخدام

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## استكشاف الأخطاء وإصلاحها

### مفتاح API غير معرّف

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

تأكّد من أن المفتاح يبدأ بـ `vapi_`.

### النموذج غير متاح

يتحدّث كتالوج نماذج Venice ديناميكيًا. شغّل `openclaw models list` لعرض النماذج المتاحة حاليًا. قد تكون بعض النماذج غير متصلة مؤقتًا.

### مشكلات الاتصال

واجهة Venice API موجودة على `https://api.venice.ai/api/v1`. تأكّد من أن شبكتك تسمح باتصالات HTTPS.

## مثال ملف التهيئة

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## الروابط

- [Venice AI](https://venice.ai)
- [توثيق واجهة API](https://docs.venice.ai)
- [التسعير](https://venice.ai/pricing)
- [الحالة](https://status.venice.ai)
