---
summary: "OpenClaw کے ساتھ Xiaomi MiMo (mimo-v2-flash) استعمال کریں"
read_when:
  - آپ OpenClaw میں Xiaomi MiMo ماڈلز چاہتے ہیں
  - آپ کو XIAOMI_API_KEY سیٹ اپ درکار ہے
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo **MiMo** ماڈلز کے لیے API پلیٹ فارم ہے۔ یہ OpenAI اور Anthropic فارمیٹس کے مطابق REST APIs فراہم کرتا ہے اور authentication کے لیے API keys استعمال کرتا ہے۔ [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys) میں اپنی API key بنائیں۔ OpenClaw Xiaomi MiMo API key کے ساتھ `xiaomi` provider استعمال کرتا ہے۔

## ماڈل کا جائزہ

- **mimo-v2-flash**: 262144-ٹوکن کانٹیکسٹ ونڈو، Anthropic Messages API کے ساتھ ہم آہنگ۔
- Base URL: `https://api.xiaomimimo.com/anthropic`
- Authorization: `Bearer $XIAOMI_API_KEY`

## CLI سیٹ اپ

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## کنفیگ ٹکڑا

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## نوٹس

- ماڈل ریف: `xiaomi/mimo-v2-flash`۔
- فراہم کنندہ خودکار طور پر شامل ہو جاتا ہے جب `XIAOMI_API_KEY` سیٹ ہو (یا کوئی auth پروفائل موجود ہو)۔
- فراہم کنندہ کے قواعد کے لیے [/concepts/model-providers](/concepts/model-providers) دیکھیں۔
