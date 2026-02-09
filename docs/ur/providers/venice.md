---
summary: "OpenClaw میں Venice AI کے رازداری پر مبنی ماڈلز استعمال کریں"
read_when:
  - آپ OpenClaw میں رازداری پر مبنی انفیرینس چاہتے ہیں
  - آپ Venice AI کے سیٹ اپ کی رہنمائی چاہتے ہیں
title: "Venice AI"
---

# Venice AI (Venice نمایاں)

**Venice** رازداری کو اولین ترجیح دینے والی انفیرینس کے لیے ہمارا نمایاں Venice سیٹ اپ ہے، جس میں ملکیتی ماڈلز تک اختیاری گمنام رسائی شامل ہے۔

Venice AI پرائیویسی پر مبنی AI inference فراہم کرتا ہے، جس میں غیر سنسرڈ ماڈلز کی سپورٹ اور ان کے anonymized proxy کے ذریعے بڑے proprietary ماڈلز تک رسائی شامل ہے۔ تمام inference ڈیفالٹ طور پر نجی ہے—آپ کے ڈیٹا پر کوئی ٹریننگ نہیں، کوئی لاگنگ نہیں۔

## OpenClaw میں Venice کیوں

- اوپن سورس ماڈلز کے لیے **نجی انفیرینس** (کوئی لاگنگ نہیں)۔
- جب ضرورت ہو **غیر سنسر شدہ ماڈلز**۔
- معیار اہم ہونے پر ملکیتی ماڈلز (Opus/GPT/Gemini) تک **گمنام رسائی**۔
- OpenAI سے مطابقت رکھنے والے `/v1` اینڈ پوائنٹس۔

## رازداری کے موڈز

Venice رازداری کی دو سطحیں پیش کرتا ہے—صحیح ماڈل منتخب کرنے کے لیے ان کو سمجھنا اہم ہے:

| موڈ       | وضاحت                                                                                                                                         | ماڈلز                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **نجی**   | مکمل طور پر نجی۔ Prompts/جوابات **کبھی بھی محفوظ یا لاگ نہیں کیے جاتے**۔ عارضی.                                               | Llama، Qwen، DeepSeek، Venice Uncensored، وغیرہ |
| **گمنام** | میٹاڈیٹا ہٹا کر Venice کے ذریعے proxy کیا جاتا ہے۔ بنیادی provider (OpenAI، Anthropic) کو anonymized ریکویسٹس نظر آتی ہیں۔ | Claude، GPT، Gemini، Grok، Kimi، MiniMax        |

## خصوصیات

- **رازداری پر مبنی**: "نجی" (مکمل نجی) اور "گمنام" (پراکسی شدہ) موڈز میں انتخاب
- **غیر سنسر شدہ ماڈلز**: مواد کی پابندیوں کے بغیر ماڈلز تک رسائی
- **اہم ماڈلز تک رسائی**: Venice کے گمنام پراکسی کے ذریعے Claude، GPT-5.2، Gemini، Grok استعمال کریں
- **OpenAI سے مطابقت رکھنے والا API**: آسان انضمام کے لیے معیاری `/v1` اینڈ پوائنٹس
- **اسٹریمنگ**: ✅ تمام ماڈلز پر سپورٹ شدہ
- **فنکشن کالنگ**: ✅ منتخب ماڈلز پر سپورٹ شدہ (ماڈل کی صلاحیتیں چیک کریں)
- **ویژن**: ✅ ویژن صلاحیت والے ماڈلز پر سپورٹ شدہ
- **سخت ریٹ لمٹس نہیں**: انتہائی استعمال پر منصفانہ استعمال کی تھروٹلنگ لاگو ہو سکتی ہے

## سیٹ اپ

### 1. API Key حاصل کریں

1. [venice.ai](https://venice.ai) پر سائن اپ کریں
2. **Settings → API Keys → Create new key** پر جائیں
3. اپنی API کلید کاپی کریں (فارمیٹ: `vapi_xxxxxxxxxxxx`)

### 2) OpenClaw کنفیگر کریں

**آپشن A: ماحولیاتی متغیر**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**آپشن B: انٹرایکٹو سیٹ اپ (سفارش کردہ)**

```bash
openclaw onboard --auth-choice venice-api-key
```

یہ درج ذیل کرے گا:

1. آپ کی API کلید طلب کرے گا (یا موجودہ `VENICE_API_KEY` استعمال کرے گا)
2. دستیاب تمام Venice ماڈلز دکھائے گا
3. آپ کو اپنا ڈیفالٹ ماڈل منتخب کرنے دے گا
4. فراہم کنندہ کو خودکار طور پر کنفیگر کرے گا

**آپشن C: غیر انٹرایکٹو**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. سیٹ اپ کی تصدیق کریں

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## ماڈل کا انتخاب

سیٹ اپ کے بعد، OpenClaw تمام دستیاب Venice ماڈلز دکھاتا ہے۔ اپنی ضروریات کے مطابق منتخب کریں:

- **ڈیفالٹ (ہماری پسند)**: نجی اور متوازن کارکردگی کے لیے `venice/llama-3.3-70b`۔
- **بہترین مجموعی معیار**: مشکل کاموں کے لیے `venice/claude-opus-45` (Opus بدستور سب سے مضبوط ہے)۔
- **رازداری**: مکمل نجی انفیرینس کے لیے "نجی" ماڈلز منتخب کریں۔
- **صلاحیت**: Venice کے پراکسی کے ذریعے Claude، GPT، Gemini تک رسائی کے لیے "گمنام" ماڈلز منتخب کریں۔

کسی بھی وقت اپنا ڈیفالٹ ماڈل تبدیل کریں:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

تمام دستیاب ماڈلز کی فہرست:

```bash
openclaw models list | grep venice
```

## `openclaw configure` کے ذریعے کنفیگریشن

1. `openclaw configure` چلائیں
2. **Model/auth** منتخب کریں
3. **Venice AI** منتخب کریں

## مجھے کون سا ماڈل استعمال کرنا چاہیے؟

| استعمال کی صورت            | سفارش کردہ ماڈل                  | وجہ                                   |
| -------------------------- | -------------------------------- | ------------------------------------- |
| **عمومی چیٹ**              | `llama-3.3-70b`                  | ہمہ گیر، مکمل نجی                     |
| **بہترین مجموعی معیار**    | `claude-opus-45`                 | مشکل کاموں کے لیے Opus سب سے مضبوط ہے |
| **رازداری + Claude معیار** | `claude-opus-45`                 | گمنام پراکسی کے ذریعے بہترین استدلال  |
| **کوڈنگ**                  | `qwen3-coder-480b-a35b-instruct` | کوڈ کے لیے بہتر، 262k کانٹیکسٹ        |
| **ویژن کام**               | `qwen3-vl-235b-a22b`             | بہترین نجی ویژن ماڈل                  |
| **غیر سنسر شدہ**           | `venice-uncensored`              | مواد کی کوئی پابندی نہیں              |
| **تیز + کم لاگت**          | `qwen3-4b`                       | ہلکا پھلکا، پھر بھی مؤثر              |
| **پیچیدہ استدلال**         | `deepseek-v3.2`                  | مضبوط استدلال، نجی                    |

## دستیاب ماڈلز (کل 25)

### نجی ماڈلز (15) — مکمل نجی، کوئی لاگنگ نہیں

| ماڈل ID                          | نام                                        | کانٹیکسٹ (ٹوکنز) | خصوصیات             |
| -------------------------------- | ------------------------------------------ | ----------------------------------- | ------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                | عمومی               |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                | تیز، ہلکا پھلکا     |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                | پیچیدہ کام          |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                | استدلال             |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                | عمومی               |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                | کوڈ                 |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                | عمومی               |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                | ویژن                |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                 | تیز، استدلال        |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                | استدلال             |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                 | غیر سنسر شدہ        |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                | ویژن                |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                | ویژن                |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                | عمومی               |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                | استدلال، کثیر لسانی |

### گمنام ماڈلز (10) — Venice پراکسی کے ذریعے

| ماڈل ID                  | اصل ماڈل                          | کانٹیکسٹ (ٹوکنز) | خصوصیات       |
| ------------------------ | --------------------------------- | ----------------------------------- | ------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                | استدلال، ویژن |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                | استدلال، ویژن |
| `openai-gpt-52`          | GPT-5.2           | 262k                                | استدلال       |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                | استدلال، ویژن |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                | استدلال، ویژن |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                | استدلال، ویژن |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                | استدلال، ویژن |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                | استدلال، کوڈ  |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                | استدلال       |
| `minimax-m21`            | MiniMax M2.1      | 202k                                | استدلال       |

## ماڈل ڈسکوری

جب `VENICE_API_KEY` سیٹ ہو تو OpenClaw Venice API سے ماڈلز خودکار طور پر دریافت کرتا ہے۔ اگر API قابلِ رسائی نہ ہو تو یہ ایک static catalog پر واپس آ جاتا ہے۔

`/models` اینڈ پوائنٹ عوامی ہے (فہرست کے لیے تصدیق درکار نہیں)، لیکن انفیرینس کے لیے درست API کلید ضروری ہے۔

## اسٹریمنگ اور اوزاروں کی سپورٹ

| خصوصیت          | سپورٹ                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| **اسٹریمنگ**    | ✅ تمام ماڈلز                                                                     |
| **فنکشن کالنگ** | ✅ زیادہ تر ماڈلز (`supportsFunctionCalling` API میں چیک کریں) |
| **ویژن/تصاویر** | ✅ "Vision" خصوصیت والے ماڈلز                                                     |
| **JSON موڈ**    | ✅ `response_format` کے ذریعے سپورٹ شدہ                                           |

## قیمتیں

Venice کریڈٹ پر مبنی سسٹم استعمال کرتا ہے۔ موجودہ ریٹس کے لیے [venice.ai/pricing](https://venice.ai/pricing) دیکھیں:

- **نجی ماڈلز**: عموماً کم لاگت
- **گمنام ماڈلز**: براہِ راست API قیمتوں کے مشابہ + Venice کی معمولی فیس

## موازنہ: Venice بمقابلہ براہِ راست API

| پہلو        | Venice (گمنام)    | براہِ راست API        |
| ----------- | ------------------------------------ | --------------------- |
| **رازداری** | میٹاڈیٹا ہٹا دیا جاتا ہے، گمنام      | آپ کے اکاؤنٹ سے منسلک |
| **تاخیر**   | +10–50ms (پراکسی) | براہِ راست            |
| **خصوصیات** | زیادہ تر خصوصیات سپورٹ شدہ           | مکمل خصوصیات          |
| **بلنگ**    | Venice کریڈٹس                        | فراہم کنندہ کی بلنگ   |

## استعمال کی مثالیں

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

## خرابیوں کا ازالہ

### API کلید پہچانی نہیں جا رہی

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

یقینی بنائیں کہ کلید `vapi_` سے شروع ہوتی ہے۔

### ماڈل دستیاب نہیں

Venice ماڈل کیٹلاگ متحرک طور پر اپڈیٹ ہوتا ہے۔ فی الحال دستیاب ماڈلز دیکھنے کے لیے `openclaw models list` چلائیں۔ کچھ ماڈلز عارضی طور پر آف لائن ہو سکتے ہیں۔

### کنکشن کے مسائل

Venice API یہاں ہے: `https://api.venice.ai/api/v1`۔ یقینی بنائیں کہ آپ کا نیٹ ورک HTTPS کنیکشنز کی اجازت دیتا ہے۔

## کنفیگ فائل کی مثال

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

## روابط

- [Venice AI](https://venice.ai)
- [API دستاویزات](https://docs.venice.ai)
- [قیمتیں](https://venice.ai/pricing)
- [اسٹیٹس](https://status.venice.ai)
