---
summary: "Bun ورک فلو (تجرباتی): pnpm کے مقابلے میں انسٹالیشن اور ممکنہ مسائل"
read_when:
  - "آپ سب سے تیز لوکل ڈیولپمنٹ لوپ چاہتے ہیں (bun + watch)"
  - "آپ کو Bun کی install/patch/lifecycle اسکرپٹس سے متعلق مسائل پیش آئے ہیں"
title: "Bun (تجرباتی)"
x-i18n:
  source_path: install/bun.md
  source_hash: eb3f4c222b6bae49
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:21Z
---

# Bun (تجرباتی)

مقصد: اس ریپو کو **Bun** کے ساتھ چلانا (اختیاری، WhatsApp/Telegram کے لیے سفارش نہیں کی جاتی)
اور pnpm ورک فلو سے انحراف کیے بغیر۔

⚠️ **Gateway رن ٹائم کے لیے سفارش نہیں کی جاتی** (WhatsApp/Telegram کی خرابیاں)۔ پروڈکشن کے لیے Node استعمال کریں۔

## Status

- Bun TypeScript کو براہِ راست چلانے کے لیے ایک اختیاری لوکل رن ٹائم ہے (`bun run …`, `bun --watch …`)۔
- `pnpm` بلڈز کے لیے بطورِ طے شدہ ہے اور مکمل طور پر معاون رہتا ہے (اور کچھ ڈاکس ٹولنگ کے ذریعے استعمال بھی ہوتا ہے)۔
- Bun `pnpm-lock.yaml` استعمال نہیں کر سکتا اور اسے نظرانداز کرے گا۔

## Install

بطورِ طے شدہ:

```sh
bun install
```

نوٹ: `bun.lock`/`bun.lockb` gitignored ہیں، اس لیے کسی بھی صورت میں ریپو میں غیر ضروری تبدیلیاں نہیں ہوتیں۔ اگر آپ _لاگ فائل میں کوئی تحریر نہیں چاہتے_ تو:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle اسکرپٹس (بطورِ طے شدہ مسدود)

Bun انحصارات کی lifecycle اسکرپٹس کو اس وقت تک مسدود کر سکتا ہے جب تک انہیں صراحتاً قابلِ اعتماد نہ بنایا جائے (`bun pm untrusted` / `bun pm trust`)۔
اس ریپو کے لیے، عام طور پر مسدود ہونے والی اسکرپٹس درکار نہیں ہیں:

- `@whiskeysockets/baileys` `preinstall`: Node کے major ورژن >= 20 کی جانچ (ہم Node 22+ چلاتے ہیں)۔
- `protobufjs` `postinstall`: غیر مطابقت پذیر ورژن اسکیمز کے بارے میں انتباہات جاری کرتی ہیں (کوئی بلڈ آرٹیفیکٹس نہیں)۔

اگر آپ کو کسی حقیقی رن ٹائم مسئلے کا سامنا ہو جس کے لیے ان اسکرپٹس کی ضرورت ہو، تو انہیں صراحتاً قابلِ اعتماد بنائیں:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- کچھ اسکرپٹس اب بھی pnpm کو ہارڈکوڈ کرتی ہیں (مثلاً `docs:build`, `ui:*`, `protocol:check`)۔ فی الحال انہیں pnpm کے ذریعے ہی چلائیں۔
