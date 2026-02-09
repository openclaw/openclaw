---
summary: "OpenClaw ماحولاتی متغیرات کہاں سے لوڈ کرتا ہے اور ترجیحی ترتیب"
read_when:
  - آپ کو یہ جاننے کی ضرورت ہو کہ کون سے env vars لوڈ ہوتے ہیں اور کس ترتیب میں
  - آپ Gateway میں گمشدہ API کلیدوں کی خرابی تلاش کر رہے ہوں
  - آپ فراہم کنندہ کی تصدیق یا ڈپلائمنٹ ماحول کی دستاویز بنا رہے ہوں
title: "ماحولاتی متغیرات"
---

# ماحولاتی متغیرات

OpenClaw pulls environment variables from multiple sources. The rule is **never override existing values**.

## ترجیحی ترتیب (اعلیٰ → ادنیٰ)

1. **پروسیس ماحول** (وہ جو Gateway پروسیس کو پہلے ہی والد شیل/ڈیمن سے ملا ہوتا ہے)۔
2. **موجودہ ورکنگ ڈائریکٹری میں `.env`** (dotenv ڈیفالٹ؛ اووررائیڈ نہیں کرتا)۔
3. **عالمی `.env`** مقام `~/.openclaw/.env` پر (جسے `$OPENCLAW_STATE_DIR/.env` بھی کہا جاتا ہے؛ اووررائیڈ نہیں کرتا)۔
4. **کنفیگ `env` بلاک** جو `~/.openclaw/openclaw.json` میں ہے (صرف اس صورت میں لاگو ہوتا ہے جب قدر موجود نہ ہو)۔
5. **اختیاری لاگ اِن-شیل امپورٹ** (`env.shellEnv.enabled` یا `OPENCLAW_LOAD_SHELL_ENV=1`)، جو صرف متوقع مگر غائب کلیدوں کے لیے لاگو ہوتا ہے۔

اگر کنفیگ فائل مکمل طور پر موجود نہ ہو تو مرحلہ 4 چھوڑ دیا جاتا ہے؛ شیل امپورٹ اگر فعال ہو تو پھر بھی چلتا ہے۔

## کنفیگ `env` بلاک

ان لائن env vars سیٹ کرنے کے دو مساوی طریقے (دونوں اووررائیڈ نہیں کرتے):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## شیل env امپورٹ

`env.shellEnv` آپ کی لاگ اِن شیل چلاتا ہے اور صرف **غائب** متوقع کلیدیں امپورٹ کرتا ہے:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var کے مساویات:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## کنفیگ میں Env var متبادل

آپ `${VAR_NAME}` نحو استعمال کرتے ہوئے کنفیگ کی اسٹرنگ قدروں میں براہِ راست env vars کا حوالہ دے سکتے ہیں:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

تفصیلات کے لیے [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) دیکھیں۔

## متعلقہ

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
