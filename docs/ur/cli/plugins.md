---
summary: "CLI کے لیے `openclaw plugins` کا حوالہ (list، install، enable/disable، doctor)"
read_when:
  - آپ in-process Gateway پلگ اِنز انسٹال یا منظم کرنا چاہتے ہیں
  - آپ پلگ اِن لوڈ کی ناکامیوں کی خرابیوں کا ازالہ کرنا چاہتے ہیں
title: "plugins"
---

# `openclaw plugins`

Gateway (گیٹ وے) پلگ اِنز/ایکسٹینشنز کا انتظام کریں (جو in-process لوڈ ہوتے ہیں)۔

متعلقہ:

- پلگ اِن سسٹم: [Plugins](/tools/plugin)
- پلگ اِن منشور + اسکیما: [Plugin manifest](/plugins/manifest)
- سکیورٹی مضبوطی: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

بنڈل شدہ پلگ اِنز OpenClaw کے ساتھ آتے ہیں لیکن ابتدا میں غیر فعال ہوتے ہیں۔ انہیں فعال کرنے کے لیے `plugins enable` استعمال کریں۔

تمام پلگ اِنز کو ایک `openclaw.plugin.json` فائل فراہم کرنا لازم ہے جس میں اِن لائن JSON Schema ہو (`configSchema`، چاہے خالی ہی کیوں نہ ہو)۔ غائب/غلط مینی فیسٹس یا اسکیما پلگ اِن کے لوڈ ہونے سے روکتے ہیں اور کنفیگ ویلیڈیشن ناکام ہو جاتی ہے۔

### Install

```bash
openclaw plugins install <path-or-spec>
```

سیکیورٹی نوٹ: پلگ اِن انسٹالز کو کوڈ چلانے کے مترادف سمجھیں۔ پن کی گئی ورژنز کو ترجیح دیں۔

معاون آرکائیوز: `.zip`, `.tgz`, `.tar.gz`, `.tar`۔

مقامی ڈائریکٹری کی کاپی سے بچنے کے لیے `--link` استعمال کریں (یہ `plugins.load.paths` میں شامل کرتا ہے):

```bash
openclaw plugins install -l ./my-plugin
```

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

اپ ڈیٹس صرف اُن پلگ اِنز پر لاگو ہوتی ہیں جو npm سے انسٹال کیے گئے ہوں (جو `plugins.installs` میں ٹریک ہوتے ہیں)۔
