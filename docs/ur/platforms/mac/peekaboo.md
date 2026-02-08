---
summary: "macOS UI آٹومیشن کے لیے PeekabooBridge کا انضمام"
read_when:
  - OpenClaw.app میں PeekabooBridge کی میزبانی
  - Swift Package Manager کے ذریعے Peekaboo کا انضمام
  - PeekabooBridge کے پروٹوکول/راستوں میں تبدیلی
title: "Peekaboo Bridge"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:28Z
---

# Peekaboo Bridge (macOS UI آٹومیشن)

OpenClaw **PeekabooBridge** کو ایک مقامی، اجازت سے آگاہ UI آٹومیشن بروکر کے طور پر میزبانی کر سکتا ہے۔
اس سے `peekaboo` CLI، macOS ایپ کی TCC اجازتوں کو دوبارہ استعمال کرتے ہوئے UI آٹومیشن چلا سکتی ہے۔

## یہ کیا ہے (اور کیا نہیں)

- **Host**: OpenClaw.app ایک PeekabooBridge ہوسٹ کے طور پر کام کر سکتا ہے۔
- **Client**: `peekaboo` CLI استعمال کریں (کوئی علیحدہ `openclaw ui ...` سطح نہیں)۔
- **UI**: بصری اوورلیز Peekaboo.app میں رہتی ہیں؛ OpenClaw ایک ہلکا بروکر ہوسٹ ہے۔

## برج فعال کریں

macOS ایپ میں:

- Settings → **Enable Peekaboo Bridge**

فعال ہونے پر، OpenClaw ایک مقامی UNIX ساکٹ سرور شروع کرتا ہے۔ اگر غیر فعال ہو، تو ہوسٹ روک دیا جاتا ہے اور `peekaboo` دستیاب دیگر ہوسٹس پر واپس چلا جائے گا۔

## کلائنٹ ڈسکوری کی ترتیب

Peekaboo کلائنٹس عموماً اس ترتیب سے ہوسٹس آزماتے ہیں:

1. Peekaboo.app (مکمل UX)
2. Claude.app (اگر انسٹال ہو)
3. OpenClaw.app (ہلکا بروکر)

فعال ہوسٹ اور استعمال میں موجود ساکٹ راستہ دیکھنے کے لیے `peekaboo bridge status --verbose` استعمال کریں۔ آپ اسے اس کے ساتھ اوور رائیڈ بھی کر سکتے ہیں:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## سکیورٹی اور اجازتیں

- برج **کالر کوڈ دستخط** کی توثیق کرتا ہے؛ TeamIDs کی اجازت فہرست نافذ کی جاتی ہے (Peekaboo ہوسٹ TeamID + OpenClaw ایپ TeamID)۔
- درخواستیں تقریباً 10 سیکنڈ بعد ٹائم آؤٹ ہو جاتی ہیں۔
- اگر مطلوبہ اجازتیں موجود نہ ہوں، تو برج System Settings لانچ کرنے کے بجائے واضح خرابی کا پیغام واپس کرتا ہے۔

## اسنیپ شاٹ رویّہ (آٹومیشن)

اسنیپ شاٹس میموری میں محفوظ ہوتے ہیں اور مختصر مدت کے بعد خودکار طور پر ختم ہو جاتے ہیں۔
اگر طویل مدتی برقرار رکھنے کی ضرورت ہو، تو کلائنٹ سے دوبارہ کیپچر کریں۔

## خرابیوں کا ازالہ

- اگر `peekaboo` “bridge client is not authorized” رپورٹ کرے، تو یقینی بنائیں کہ کلائنٹ درست طور پر سائن کیا گیا ہے یا ہوسٹ کو `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` کے ساتھ صرف **debug** موڈ میں چلائیں۔
- اگر کوئی ہوسٹس نہ ملیں، تو ہوسٹ ایپس میں سے کسی ایک (Peekaboo.app یا OpenClaw.app) کو کھولیں اور تصدیق کریں کہ اجازتیں دی گئی ہیں۔
