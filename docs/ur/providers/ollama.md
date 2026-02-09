---
summary: "Ollama (لوکل LLM رن ٹائم) کے ساتھ OpenClaw چلائیں"
read_when:
  - آپ Ollama کے ذریعے لوکل ماڈلز کے ساتھ OpenClaw چلانا چاہتے ہیں
  - آپ کو Ollama کے سیٹ اپ اور کنفیگریشن کی رہنمائی درکار ہے
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's OpenAI-compatible API and can **auto-discover tool-capable models** when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

## فوری آغاز

1. Ollama انسٹال کریں: [https://ollama.ai](https://ollama.ai)

2. ایک ماڈل پل کریں:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. OpenClaw کے لیے Ollama فعال کریں (کوئی بھی ویلیو کام کرے گی؛ Ollama کو حقیقی کلید درکار نہیں):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollama ماڈلز استعمال کریں:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## ماڈل ڈسکوری (ضمنی فراہم کنندہ)

جب آپ `OLLAMA_API_KEY` (یا ایک auth پروفائل) سیٹ کرتے ہیں اور **`models.providers.ollama` متعین نہیں کرتے**، تو OpenClaw لوکل Ollama انسٹینس سے `http://127.0.0.1:11434` پر ماڈلز دریافت کرتا ہے:

- `/api/tags` اور `/api/show` کو کوئری کرتا ہے
- صرف اُن ماڈلز کو رکھتا ہے جو `tools` کی صلاحیت رپورٹ کرتے ہیں
- جب ماڈل `thinking` رپورٹ کرے تو `reasoning` کو نشان زد کرتا ہے
- دستیاب ہونے پر `model_info["<arch>.context_length"]` سے `contextWindow` پڑھتا ہے
- کانٹیکسٹ ونڈو کے 10× کے برابر `maxTokens` سیٹ کرتا ہے
- تمام لاگتیں `0` پر سیٹ کرتا ہے

یہ طریقہ Ollama کی صلاحیتوں کے ساتھ کیٹلاگ کو ہم آہنگ رکھتے ہوئے دستی ماڈل انٹریز سے بچاتا ہے۔

یہ دیکھنے کے لیے کہ کون سے ماڈلز دستیاب ہیں:

```bash
ollama list
openclaw models list
```

نیا ماڈل شامل کرنے کے لیے، بس اسے Ollama کے ساتھ پل کریں:

```bash
ollama pull mistral
```

نیا ماڈل خودکار طور پر دریافت ہو جائے گا اور استعمال کے لیے دستیاب ہوگا۔

اگر آپ `models.providers.ollama` کو واضح طور پر سیٹ کرتے ہیں تو خودکار ڈسکوری نظرانداز ہو جاتی ہے اور آپ کو ماڈلز دستی طور پر متعین کرنا ہوں گے (نیچے دیکھیں)۔

## کنفیگریشن

### بنیادی سیٹ اپ (ضمنی ڈسکوری)

Ollama کو فعال کرنے کا سب سے سادہ طریقہ ماحولیاتی متغیر کے ذریعے ہے:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### واضح سیٹ اپ (دستی ماڈلز)

واضح کنفیگ اس وقت استعمال کریں جب:

- Ollama کسی دوسرے ہوسٹ/پورٹ پر چل رہا ہو۔
- آپ مخصوص کانٹیکسٹ ونڈوز یا ماڈل فہرستیں مجبوراً سیٹ کرنا چاہتے ہوں۔
- آپ ایسے ماڈلز شامل کرنا چاہتے ہوں جو ٹول سپورٹ رپورٹ نہیں کرتے۔

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

اگر `OLLAMA_API_KEY` سیٹ ہے تو آپ فراہم کنندہ انٹری میں `apiKey` کو چھوڑ سکتے ہیں اور OpenClaw دستیابی کی جانچ کے لیے اسے خود بھر دے گا۔

### کسٹم بیس URL (واضح کنفیگ)

اگر Ollama کسی مختلف ہوسٹ یا پورٹ پر چل رہا ہو (واضح کنفیگ خودکار ڈسکوری کو غیر فعال کر دیتا ہے، اس لیے ماڈلز دستی طور پر متعین کریں):

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

### ماڈل انتخاب

کنفیگر ہونے کے بعد، آپ کے تمام Ollama ماڈلز دستیاب ہوں گے:

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

## ایڈوانسڈ

### ریزننگ ماڈلز

OpenClaw ماڈلز کو ریزننگ-قابل اس وقت نشان زد کرتا ہے جب Ollama، `/api/show` میں `thinking` رپورٹ کرے:

```bash
ollama pull deepseek-r1:32b
```

### ماڈل لاگتیں

Ollama مفت ہے اور لوکل طور پر چلتا ہے، اس لیے تمام ماڈل لاگتیں $0 پر سیٹ ہوتی ہیں۔

### اسٹریمنگ کنفیگریشن

Due to a [known issue](https://github.com/badlogic/pi-mono/issues/1205) in the underlying SDK with Ollama's response format, **streaming is disabled by default** for Ollama models. This prevents corrupted responses when using tool-capable models.

جب اسٹریمنگ غیر فعال ہو تو جوابات ایک ہی بار میں فراہم کیے جاتے ہیں (نان-اسٹریمنگ موڈ)، جس سے وہ مسئلہ ختم ہو جاتا ہے جہاں باہم ملی ہوئی مواد/ریزَننگ ڈیلٹاز آؤٹ پٹ کو بگاڑ دیتی ہیں۔

#### اسٹریمنگ دوبارہ فعال کریں (ایڈوانسڈ)

اگر آپ Ollama کے لیے اسٹریمنگ دوبارہ فعال کرنا چاہتے ہیں (ٹول کی صلاحیت رکھنے والے ماڈلز کے ساتھ مسائل پیدا ہو سکتے ہیں):

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

#### دیگر فراہم کنندگان کے لیے اسٹریمنگ غیر فعال کریں

ضرورت پڑنے پر آپ کسی بھی فراہم کنندہ کے لیے اسٹریمنگ غیر فعال کر سکتے ہیں:

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

### کانٹیکسٹ ونڈوز

For auto-discovered models, OpenClaw uses the context window reported by Ollama when available, otherwise it defaults to `8192`. You can override `contextWindow` and `maxTokens` in explicit provider config.

## خرابیوں کا ازالہ

### Ollama کی شناخت نہیں ہو رہی

یقینی بنائیں کہ Ollama چل رہا ہے اور آپ نے `OLLAMA_API_KEY` (یا ایک auth پروفائل) سیٹ کیا ہے، اور یہ کہ آپ نے کوئی واضح `models.providers.ollama` انٹری **متعین نہیں** کی:

```bash
ollama serve
```

اور یہ کہ API قابلِ رسائی ہے:

```bash
curl http://localhost:11434/api/tags
```

### کوئی ماڈل دستیاب نہیں

OpenClaw only auto-discovers models that report tool support. If your model isn't listed, either:

- ٹول کی صلاحیت رکھنے والا ماڈل پل کریں، یا
- `models.providers.ollama` میں ماڈل کو واضح طور پر متعین کریں۔

ماڈلز شامل کرنے کے لیے:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### کنکشن ریفیوزڈ

چیک کریں کہ Ollama درست پورٹ پر چل رہا ہے:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### خراب ریسپانسز یا آؤٹ پٹ میں ٹول نام

If you see garbled responses containing tool names (like `sessions_send`, `memory_get`) or fragmented text when using Ollama models, this is due to an upstream SDK issue with streaming responses. **This is fixed by default** in the latest OpenClaw version by disabling streaming for Ollama models.

اگر آپ نے دستی طور پر اسٹریمنگ فعال کی ہے اور یہ مسئلہ پیش آ رہا ہے:

1. اپنے Ollama ماڈل انٹریز سے `streaming: true` کنفیگریشن ہٹا دیں، یا
2. Ollama ماڈلز کے لیے واضح طور پر `streaming: false` سیٹ کریں (دیکھیں [اسٹریمنگ کنفیگریشن](#streaming-configuration))

## یہ بھی دیکھیں

- [Model Providers](/concepts/model-providers) - تمام فراہم کنندگان کا جائزہ
- [Model Selection](/concepts/models) - ماڈلز منتخب کرنے کا طریقہ
- [Configuration](/gateway/configuration) - مکمل کنفیگ ریفرنس
