---
summary: "OpenClaw میں MiniMax M2.1 استعمال کریں"
read_when:
  - آپ OpenClaw میں MiniMax ماڈلز چاہتے ہیں
  - آپ کو MiniMax کے سیٹ اپ کی رہنمائی درکار ہے
title: "MiniMax"
---

# MiniMax

MiniMax is an AI company that builds the **M2/M2.1** model family. The current
coding-focused release is **MiniMax M2.1** (December 23, 2025), built for
real-world complex tasks.

ماخذ: [MiniMax M2.1 ریلیز نوٹ](https://www.minimax.io/news/minimax-m21)

## ماڈل جائزہ (M2.1)

MiniMax نے M2.1 میں درج ذیل بہتریوں کو نمایاں کیا ہے:

- زیادہ مضبوط **کثیر لسانی کوڈنگ** (Rust، Java، Go، C++، Kotlin، Objective-C، TS/JS)۔
- بہتر **ویب/ایپ ڈیولپمنٹ** اور جمالیاتی آؤٹ پٹ معیار (بشمول نیٹو موبائل)۔
- دفتری طرز کے ورک فلو کے لیے **مرکب ہدایات** کی بہتر ہینڈلنگ، جو
  interleaved thinking اور integrated constraint execution پر مبنی ہے۔
- **مزید مختصر جوابات**، کم ٹوکن استعمال اور تیز تر iteration loops۔
- **tool/agent فریم ورک** کے ساتھ زیادہ مضبوط مطابقت اور سیاق و سباق کا انتظام (Claude Code،
  Droid/Factory AI، Cline، Kilo Code، Roo Code، BlackBox)۔
- اعلیٰ معیار کی **مکالماتی اور تکنیکی تحریر** کی آؤٹ پٹس۔

## MiniMax M2.1 بمقابلہ MiniMax M2.1 Lightning

- **رفتار:** Lightning، MiniMax کی قیمتوں کی دستاویزات میں “تیز” ویریئنٹ ہے۔
- **لاگت:** قیمتوں میں ان پٹ لاگت یکساں دکھائی گئی ہے، مگر Lightning کی آؤٹ پٹ لاگت زیادہ ہے۔
- **Coding plan routing:** The Lightning back-end isn’t directly available on the MiniMax
  coding plan. MiniMax auto-routes most requests to Lightning, but falls back to the
  regular M2.1 back-end during traffic spikes.

## سیٹ اپ منتخب کریں

### MiniMax OAuth (Coding Plan) — سفارش کردہ

**بہترین کے لیے:** OAuth کے ذریعے MiniMax Coding Plan کے ساتھ فوری سیٹ اپ، API کلید درکار نہیں۔

بنڈلڈ OAuth پلگ اِن کو فعال کریں اور تصدیق کریں:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

آپ سے ایک اینڈ پوائنٹ منتخب کرنے کو کہا جائے گا:

- **Global** - بین الاقوامی صارفین (`api.minimax.io`)
- **CN** - چین میں صارفین (`api.minimaxi.com`)

تفصیلات کے لیے [MiniMax OAuth پلگ اِن README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) دیکھیں۔

### MiniMax M2.1 (API key)

**بہترین کے لیے:** Anthropic-compatible API کے ساتھ ہوسٹڈ MiniMax۔

CLI کے ذریعے کنفیگر کریں:

- `openclaw configure` چلائیں
- **Model/auth** منتخب کریں
- **MiniMax M2.1** منتخب کریں

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 بطور فالبیک (Opus primary)

**بہترین کے لیے:** Opus 4.6 کو بطور پرائمری برقرار رکھیں، اور ناکامی کی صورت میں MiniMax M2.1 پر منتقل ہوں۔

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### اختیاری: LM Studio کے ذریعے لوکل (دستی)

**Best for:** local inference with LM Studio.
We have seen strong results with MiniMax M2.1 on powerful hardware (e.g. a
desktop/server) using LM Studio's local server.

`openclaw.json` کے ذریعے دستی طور پر کنفیگر کریں:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
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

## `openclaw configure` کے ذریعے کنفیگر کریں

JSON میں ترمیم کیے بغیر MiniMax سیٹ کرنے کے لیے interactive config wizard استعمال کریں:

1. `openclaw configure` چلائیں۔
2. **Model/auth** منتخب کریں۔
3. **MiniMax M2.1** منتخب کریں۔
4. جب کہا جائے تو اپنا ڈیفالٹ ماڈل منتخب کریں۔

## کنفیگریشن کے اختیارات

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` کو ترجیح دیں (Anthropic-compatible)؛ `https://api.minimax.io/v1` OpenAI-compatible payloads کے لیے اختیاری ہے۔
- `models.providers.minimax.api`: `anthropic-messages` کو ترجیح دیں؛ `openai-completions` OpenAI-compatible payloads کے لیے اختیاری ہے۔
- `models.providers.minimax.apiKey`: MiniMax API کلید (`MINIMAX_API_KEY`)۔
- `models.providers.minimax.models`: `id`، `name`، `reasoning`، `contextWindow`، `maxTokens`، `cost` کی تعریف کریں۔
- `agents.defaults.models`: وہ ماڈلز عرفی نام دیں جنہیں آپ اجازت فہرست میں چاہتے ہیں۔
- `models.mode`: اگر آپ بلٹ اِنز کے ساتھ MiniMax شامل کرنا چاہتے ہیں تو `merge` برقرار رکھیں۔

## نوٹس

- ماڈل ریفرنسز `minimax/<model>` ہیں۔
- Coding Plan کے استعمال کی API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (کوڈنگ پلان کلید درکار ہے)۔
- اگر آپ کو درست لاگت ٹریکنگ درکار ہو تو `models.json` میں قیمتوں کی قدریں اپ ڈیٹ کریں۔
- MiniMax Coding Plan کے لیے ریفرل لنک (10% رعایت): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- فراہم کنندہ کے قواعد کے لیے [/concepts/model-providers](/concepts/model-providers) دیکھیں۔
- سوئچ کرنے کے لیے `openclaw models list` اور `openclaw models set minimax/MiniMax-M2.1` استعمال کریں۔

## خرابیوں کا ازالہ

### “Unknown model: minimax/MiniMax-M2.1”

This usually means the **MiniMax provider isn’t configured** (no provider entry
and no MiniMax auth profile/env key found). A fix for this detection is in
**2026.1.12** (unreleased at the time of writing). Fix by:

- **2026.1.12** پر اپ گریڈ کریں (یا سورس سے `main` چلائیں)، پھر Gateway کو ری اسٹارٹ کریں۔
- `openclaw configure` چلائیں اور **MiniMax M2.1** منتخب کریں، یا
- `models.providers.minimax` بلاک دستی طور پر شامل کریں، یا
- `MINIMAX_API_KEY` (یا MiniMax auth پروفائل) سیٹ کریں تاکہ فراہم کنندہ شامل کیا جا سکے۔

یقینی بنائیں کہ ماڈل آئی ڈی **case‑sensitive** ہے:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

پھر دوبارہ چیک کریں:

```bash
openclaw models list
```
