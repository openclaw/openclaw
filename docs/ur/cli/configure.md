---
summary: "CLI کے لیے حوالہ: `openclaw configure` (انٹرایکٹو کنفیگریشن پرامپٹس)"
read_when:
  - آپ اس وقت جب اسناد، ڈیوائسز، یا ایجنٹ کی ڈیفالٹس کو انٹرایکٹو طور پر ایڈجسٹ کرنا چاہتے ہوں
title: "کنفیگر"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:58Z
---

# `openclaw configure`

اسناد، ڈیوائسز، اور ایجنٹ کی ڈیفالٹس سیٹ کرنے کے لیے انٹرایکٹو پرامپٹ۔

نوٹ: **Model** سیکشن میں اب `agents.defaults.models` اجازت فہرست کے لیے ملٹی-سلیکٹ شامل ہے (جو `/model` اور ماڈل پکر میں ظاہر ہوتا ہے)۔

مشورہ: بغیر ذیلی کمانڈ کے `openclaw config` چلانے سے یہی وزرڈ کھلتا ہے۔ نان-انٹرایکٹو ترامیم کے لیے `openclaw config get|set|unset` استعمال کریں۔

متعلقہ:

- Gateway کنفیگریشن حوالہ: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

نوٹس:

- Gateway کہاں چلتا ہے اس کا انتخاب ہمیشہ `gateway.mode` کو اپڈیٹ کرتا ہے۔ اگر بس یہی درکار ہو تو آپ دیگر سیکشنز کے بغیر "Continue" منتخب کر سکتے ہیں۔
- چینل پر مبنی سروسز (Slack/Discord/Matrix/Microsoft Teams) سیٹ اپ کے دوران چینل/روم اجازت فہرستوں کے لیے پرامپٹ کرتی ہیں۔ آپ نام یا IDs درج کر سکتے ہیں؛ جہاں ممکن ہو وزرڈ ناموں کو IDs میں ریزولو کرتا ہے۔

## مثالیں

```bash
openclaw configure
openclaw configure --section models --section channels
```
