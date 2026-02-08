---
summary: "CLI کے لیے `openclaw plugins` کا حوالہ (list، install، enable/disable، doctor)"
read_when:
  - آپ in-process Gateway پلگ اِنز انسٹال یا منظم کرنا چاہتے ہیں
  - آپ پلگ اِن لوڈ کی ناکامیوں کی خرابیوں کا ازالہ کرنا چاہتے ہیں
title: "plugins"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:05Z
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

بنڈل شدہ پلگ اِنز OpenClaw کے ساتھ فراہم کیے جاتے ہیں لیکن ابتدا میں غیرفعال ہوتے ہیں۔ انہیں فعال کرنے کے لیے `plugins enable` استعمال کریں۔

تمام پلگ اِنز کے ساتھ ایک `openclaw.plugin.json` فائل ہونی چاہیے جس میں inline JSON Schema (`configSchema`، چاہے خالی ہی کیوں نہ ہو) شامل ہو۔ منشور یا اسکیما کے غائب یا غلط ہونے کی صورت میں پلگ اِن لوڈ نہیں ہوتا اور کنفیگ کی توثیق ناکام ہو جاتی ہے۔

### Install

```bash
openclaw plugins install <path-or-spec>
```

سکیورٹی نوٹ: پلگ اِن انسٹالیشن کو کوڈ چلانے کے مترادف سمجھیں۔ پن کی گئی ورژنز کو ترجیح دیں۔

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
