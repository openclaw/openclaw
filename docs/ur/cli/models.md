---
summary: "CLI حوالہ برائے `openclaw models` (اسٹیٹس/فہرست/سیٹ/اسکین، عرفیات، فال بیکس، تصدیق)"
read_when:
  - آپ ڈیفالٹ ماڈلز تبدیل کرنا یا فراہم کنندہ کی تصدیقی حالت دیکھنا چاہتے ہوں
  - آپ دستیاب ماڈلز/فراہم کنندگان اسکین کرنا اور تصدیقی پروفائلز کی خرابیوں کا ازالہ کرنا چاہتے ہوں
title: "ماڈلز"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:05Z
---

# `openclaw models`

ماڈل ڈسکوری، اسکیننگ، اور کنفیگریشن (ڈیفالٹ ماڈل، فال بیکس، تصدیقی پروفائلز)۔

متعلقہ:

- فراہم کنندگان + ماڈلز: [Models](/providers/models)
- فراہم کنندہ کی تصدیق سیٹ اپ: [Getting started](/start/getting-started)

## Common commands

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` حل شدہ ڈیفالٹ/فال بیکس کے ساتھ تصدیق کا مجموعی جائزہ دکھاتا ہے۔
جب فراہم کنندہ کے استعمال کے اسنیپ شاٹس دستیاب ہوں، تو OAuth/ٹوکن اسٹیٹس سیکشن میں
فراہم کنندہ کے استعمال کے ہیڈرز شامل ہوتے ہیں۔
ہر کنفیگر شدہ فراہم کنندہ پروفائل کے خلاف لائیو تصدیقی پروبز چلانے کے لیے `--probe` شامل کریں۔
پروبز حقیقی درخواستیں ہوتی ہیں (ٹوکنز خرچ ہو سکتے ہیں اور ریٹ لمٹس فعال ہو سکتی ہیں)۔
کنفیگر شدہ ایجنٹ کے ماڈل/تصدیقی اسٹیٹ کا معائنہ کرنے کے لیے `--agent <id>` استعمال کریں۔ جب اسے چھوڑ دیا جائے،
تو کمانڈ `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` استعمال کرتی ہے اگر سیٹ ہوں، بصورتِ دیگر
کنفیگر شدہ ڈیفالٹ ایجنٹ استعمال ہوتا ہے۔

نوٹس:

- `models set <model-or-alias>`، `provider/model` یا کسی عرف کو قبول کرتا ہے۔
- ماڈل ریفرنسز **پہلے** `/` پر اسپلٹ کر کے پارس کیے جاتے ہیں۔ اگر ماڈل ID میں `/` شامل ہو (OpenRouter طرز)، تو فراہم کنندہ کا پری فکس شامل کریں (مثال: `openrouter/moonshotai/kimi-k2`)۔
- اگر آپ فراہم کنندہ چھوڑ دیں، تو OpenClaw ان پٹ کو عرف یا **ڈیفالٹ فراہم کنندہ** کے ماڈل کے طور پر لیتا ہے (یہ صرف اسی صورت میں کام کرتا ہے جب ماڈل ID میں `/` موجود نہ ہو)۔

### `models status`

اختیارات:

- `--json`
- `--plain`
- `--check` (exit 1=میعاد ختم/غیر موجود، 2=قریبِ اختتام)
- `--probe` (کنفیگر شدہ تصدیقی پروفائلز کی لائیو پروب)
- `--probe-provider <name>` (ایک فراہم کنندہ کی پروب)
- `--probe-profile <id>` (دہرائیں یا کوما سے جدا پروفائل IDs)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (کنفیگر شدہ ایجنٹ ID؛ `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` کو اوور رائیڈ کرتا ہے)

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Auth profiles

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` فراہم کنندہ پلگ اِن کے تصدیقی فلو (OAuth/API کلید) کو چلاتا ہے۔ نصب شدہ فراہم کنندگان دیکھنے کے لیے
`openclaw plugins list` استعمال کریں۔

نوٹس:

- `setup-token` سیٹ اپ ٹوکن کی قدر کے لیے پرامپٹ کرتا ہے (کسی بھی مشین پر `claude setup-token` کے ذریعے اسے جنریٹ کریں)۔
- `paste-token` کہیں اور یا آٹومیشن سے تیار کردہ ٹوکن اسٹرنگ قبول کرتا ہے۔
