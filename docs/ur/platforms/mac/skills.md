---
summary: "macOS Skills کی سیٹنگز UI اور گیٹ وے پر مبنی اسٹیٹس"
read_when:
  - macOS Skills سیٹنگز UI کو اپ ڈیٹ کرتے وقت
  - Skills کی گیٹنگ یا انسٹال کے رویّے میں تبدیلی کرتے وقت
title: "Skills"
---

# Skills (macOS)

macOS ایپ OpenClaw Skills کو گیٹ وے کے ذریعے پیش کرتی ہے؛ یہ Skills کو مقامی طور پر پارس نہیں کرتی۔

## Data source

- `skills.status` (gateway) تمام Skills کے ساتھ اہلیت اور گمشدہ تقاضے واپس کرتا ہے
  (بشمول بنڈلڈ Skills کے لیے اجازت فہرست کی رکاوٹیں)۔
- تقاضے ہر `SKILL.md` میں `metadata.openclaw.requires` سے اخذ کیے جاتے ہیں۔

## Install actions

- `metadata.openclaw.install` انسٹال کے اختیارات کی تعریف کرتا ہے (brew/node/go/uv)۔
- ایپ گیٹ وے ہوسٹ پر انسٹالرز چلانے کے لیے `skills.install` کو کال کرتی ہے۔
- جب متعدد انسٹالر فراہم ہوں تو گیٹ وے صرف ایک ترجیحی انسٹالر ظاہر کرتا ہے
  (دستیاب ہونے پر brew، ورنہ `skills.install` سے node manager، بطورِ طے شدہ npm)۔

## Env/API keys

- ایپ کیز کو `~/.openclaw/openclaw.json` میں `skills.entries.<skillKey>` کے تحت محفوظ کرتی ہے\`.
- `skills.update`، `enabled`، `apiKey`، اور `env` کو پیچ کرتا ہے۔

## Remote mode

- انسٹال + کنفیگ اپ ڈیٹس گیٹ وے ہوسٹ پر ہوتی ہیں (مقامی Mac پر نہیں)۔
