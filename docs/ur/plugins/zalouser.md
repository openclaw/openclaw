---
summary: "Zalo پرسنل پلگ اِن: zca-cli کے ذریعے QR لاگ اِن + میسجنگ (پلگ اِن انسٹال + چینل کنفیگ + CLI + ٹول)"
read_when:
  - آپ OpenClaw میں Zalo پرسنل (غیر سرکاری) سپورٹ چاہتے ہیں
  - آپ zalouser پلگ اِن کو کنفیگر یا ڈیولپ کر رہے ہیں
title: "Zalo پرسنل پلگ اِن"
x-i18n:
  source_path: plugins/zalouser.md
  source_hash: b29b788b023cd507
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:33Z
---

# Zalo پرسنل (پلگ اِن)

OpenClaw کے لیے Zalo پرسنل سپورٹ بطور پلگ اِن، جو `zca-cli` استعمال کرتے ہوئے ایک عام Zalo یوزر اکاؤنٹ کو خودکار بناتا ہے۔

> **تنبیہ:** غیر سرکاری آٹومیشن کے نتیجے میں اکاؤنٹ معطل یا بین ہو سکتا ہے۔ اپنے ذمہ استعمال کریں۔

## نام گذاری

چینل آئی ڈی `zalouser` ہے تاکہ واضح رہے کہ یہ **پرسنل Zalo یوزر اکاؤنٹ** (غیر سرکاری) کو خودکار بناتا ہے۔ ہم مستقبل میں ممکنہ سرکاری Zalo API انضمام کے لیے `zalo` محفوظ رکھتے ہیں۔

## یہ کہاں چلتا ہے

یہ پلگ اِن **Gateway پروسیس کے اندر** چلتا ہے۔

اگر آپ ریموٹ Gateway استعمال کرتے ہیں تو اسے **Gateway چلانے والی مشین** پر انسٹال/کنفیگر کریں، پھر Gateway کو ری اسٹارٹ کریں۔

## انسٹال

### آپشن A: npm سے انسٹال کریں

```bash
openclaw plugins install @openclaw/zalouser
```

اس کے بعد Gateway کو ری اسٹارٹ کریں۔

### آپشن B: لوکل فولڈر سے انسٹال کریں (ڈیولپمنٹ)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

اس کے بعد Gateway کو ری اسٹارٹ کریں۔

## پیشگی تقاضا: zca-cli

Gateway مشین پر `zca` کو `PATH` پر موجود ہونا لازمی ہے:

```bash
zca --version
```

## کنفیگ

چینل کنفیگ `channels.zalouser` کے تحت موجود ہے (نہ کہ `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## ایجنٹ ٹول

ٹول کا نام: `zalouser`

ایکشنز: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
