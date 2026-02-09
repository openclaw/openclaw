---
summary: "لوکل LLMs پر OpenClaw چلائیں (LM Studio، vLLM، LiteLLM، حسبِ ضرورت OpenAI اینڈ پوائنٹس)"
read_when:
  - آپ اپنے GPU باکس سے ماڈلز فراہم کرنا چاہتے ہیں
  - آپ LM Studio یا OpenAI کے موافق پراکسی جوڑ رہے ہیں
  - آپ کو لوکل ماڈلز کے لیے محفوظ ترین رہنمائی درکار ہے
title: "لوکل ماڈلز"
---

# لوکل ماڈلز

13. لوکل ممکن ہے، لیکن OpenClaw بڑے کانٹیکسٹ + پرامپٹ انجیکشن کے خلاف مضبوط دفاعات کی توقع کرتا ہے۔ 14. چھوٹے کارڈز کانٹیکسٹ کو مختصر کر دیتے ہیں اور سیفٹی لیک ہو جاتی ہے۔ 15. بلند ہدف رکھیں: **≥2 مکمل طور پر میکس آؤٹ Mac Studios یا مساوی GPU رِگ (~$30k+)**۔ 16. ایک واحد **24 GB** GPU صرف ہلکے پرامپٹس کے لیے زیادہ لیٹنسی کے ساتھ کام کرتا ہے۔ 17. **سب سے بڑا / فل سائز ماڈل ویریئنٹ جو آپ چلا سکتے ہیں استعمال کریں**؛ سخت کوانٹائزڈ یا “small” چیک پوائنٹس پرامپٹ انجیکشن کے خطرے کو بڑھاتے ہیں (دیکھیں [Security](/gateway/security))۔

## سفارش کردہ: LM Studio + MiniMax M2.1 (Responses API، مکمل سائز)

18. موجودہ بہترین لوکل اسٹیک۔ 19. LM Studio میں MiniMax M2.1 لوڈ کریں، لوکل سرور فعال کریں (ڈیفالٹ `http://127.0.0.1:1234`)، اور ریزننگ کو حتمی متن سے الگ رکھنے کے لیے Responses API استعمال کریں۔

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

**سیٹ اپ چیک لسٹ**

- LM Studio انسٹال کریں: [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio میں **دستیاب سب سے بڑا MiniMax M2.1 بِلڈ** ڈاؤن لوڈ کریں (“small”/شدید کوانٹائزڈ ویریئنٹس سے گریز کریں)، سرور شروع کریں، اور تصدیق کریں کہ `http://127.0.0.1:1234/v1/models` اسے فہرست میں دکھاتا ہے۔
- ماڈل لوڈ رکھیں؛ کولڈ لوڈ اسٹارٹ اپ لیٹنسی بڑھاتا ہے۔
- اگر آپ کے LM Studio بِلڈ میں فرق ہو تو `contextWindow`/`maxTokens` ایڈجسٹ کریں۔
- WhatsApp کے لیے Responses API پر قائم رہیں تاکہ صرف حتمی متن بھیجا جائے۔

لوکل چلانے کے باوجود ہوسٹڈ ماڈلز کی کنفیگریشن برقرار رکھیں؛ `models.mode: "merge"` استعمال کریں تاکہ فال بیکس دستیاب رہیں۔

### ہائبرڈ کنفیگ: ہوسٹڈ پرائمری، لوکل فال بیک

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

### لوکل-فرسٹ مع ہوسٹڈ حفاظتی جال

پرائمری اور فال بیک کی ترتیب بدل دیں؛ وہی providers بلاک اور `models.mode: "merge"` برقرار رکھیں تاکہ لوکل باکس ڈاؤن ہونے پر Sonnet یا Opus پر واپس جایا جا سکے۔

### علاقائی ہوسٹنگ / ڈیٹا روٹنگ

- 20. Hosted MiniMax/Kimi/GLM ویریئنٹس OpenRouter پر ریجن-پنڈ اینڈ پوائنٹس کے ساتھ بھی موجود ہیں (مثلاً US-hosted)۔ 21. وہاں ریجنل ویریئنٹ منتخب کریں تاکہ ٹریفک آپ کے منتخب دائرہ اختیار میں رہے، جبکہ Anthropic/OpenAI فال بیکس کے لیے `models.mode: "merge"` استعمال ہوتا رہے۔
- لوکل-اونلی سب سے مضبوط پرائیویسی راستہ ہے؛ جب آپ کو فراہم کنندہ کی خصوصیات درکار ہوں مگر ڈیٹا فلو پر کنٹرول چاہتے ہوں تو ہوسٹڈ علاقائی روٹنگ درمیانی حل ہے۔

## دیگر OpenAI کے موافق لوکل پراکسیز

22. vLLM، LiteLLM، OAI-proxy، یا کسٹم گیٹ ویز کام کرتے ہیں اگر وہ OpenAI طرز کا `/v1` اینڈ پوائنٹ ایکسپوز کریں۔ 23. اوپر والے provider بلاک کو اپنے اینڈ پوائنٹ اور ماڈل ID سے بدلیں:

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

`models.mode: "merge"` برقرار رکھیں تاکہ ہوسٹڈ ماڈلز فال بیکس کے طور پر دستیاب رہیں۔

## خرابیوں کا ازالہ

- 24. کیا گیٹ وے پراکسی تک پہنچ سکتا ہے؟ 25. `curl http://127.0.0.1:1234/v1/models`.
- 26. LM Studio ماڈل ان لوڈ ہے؟ 27. دوبارہ لوڈ کریں؛ کولڈ اسٹارٹ عام طور پر “ہینگ” ہونے کی وجہ ہوتا ہے۔
- 28. کانٹیکسٹ ایررز؟ 29. `contextWindow` کم کریں یا اپنے سرور کی حد بڑھائیں۔
- سکیورٹی: لوکل ماڈلز فراہم کنندہ کی جانب سے فلٹرز چھوڑ دیتے ہیں؛ ایجنٹس کو محدود رکھیں اور پرامپٹ انجیکشن کے اثرات محدود کرنے کے لیے کمپیکشن آن رکھیں۔
