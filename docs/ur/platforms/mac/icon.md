---
summary: "macOS پر OpenClaw کے لیے مینو بار آئیکن کی حالتیں اور اینیمیشنز"
read_when:
  - مینو بار آئیکن کے رویّے میں تبدیلی کرتے وقت
title: "مینو بار آئیکن"
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:28Z
---

# مینو بار آئیکن کی حالتیں

Author: steipete · Updated: 2025-12-06 · Scope: macOS ایپ (`apps/macos`)

- **Idle:** معمول کی آئیکن اینیمیشن (پلک جھپکنا، کبھی کبھار ہلکی جنبش)۔
- **Paused:** اسٹیٹس آئٹم `appearsDisabled` استعمال کرتا ہے؛ کوئی حرکت نہیں۔
- **Voice trigger (big ears):** وائس ویک ڈیٹیکٹر ویک ورڈ سننے پر `AppState.triggerVoiceEars(ttl: nil)` کال کرتا ہے، اور گفتگو کے کیپچر کے دوران `earBoostActive=true` برقرار رکھتا ہے۔ کان بڑے ہو جاتے ہیں (1.9x)، پڑھنے کی سہولت کے لیے گول کانوں کے سوراخ بن جاتے ہیں، پھر 1 سیکنڈ کی خاموشی کے بعد `stopVoiceEars()` کے ذریعے واپس گر جاتے ہیں۔ یہ صرف اِن ایپ وائس پائپ لائن سے فائر ہوتا ہے۔
- **Working (agent running):** `AppState.isWorking=true` ایک “tail/leg scurry” مائیکرو موشن چلاتا ہے: کام جاری ہونے کے دوران ٹانگوں کی تیز جنبش اور ہلکا سا آفسیٹ۔ فی الحال WebChat ایجنٹ رنز کے گرد ٹوگل ہوتا ہے؛ جب آپ دیگر طویل کام وائر کریں تو ان کے گرد بھی یہی ٹوگل شامل کریں۔

Wiring points

- Voice wake: رن ٹائم/ٹیسٹر ٹرگر پر `AppState.triggerVoiceEars(ttl: nil)` کال کرے اور کیپچر ونڈو سے میچ کرنے کے لیے 1 سیکنڈ کی خاموشی کے بعد `stopVoiceEars()` کال کرے۔
- Agent activity: کام کے وقفوں کے اردگرد `AppStateStore.shared.setWorking(true/false)` سیٹ کریں (WebChat ایجنٹ کال میں پہلے ہی ہو چکا ہے)۔ اسپینز مختصر رکھیں اور پھنسے ہوئے اینیمیشنز سے بچنے کے لیے `defer` بلاکس میں ری سیٹ کریں۔

Shapes & sizes

- بیس آئیکن `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` میں ڈرا کیا گیا ہے۔
- Ear scale بطورِ طے شدہ `1.0` ہے؛ وائس بوسٹ `earScale=1.9` سیٹ کرتا ہے اور مجموعی فریم بدلے بغیر `earHoles=true` ٹوگل کرتا ہے (18×18 pt ٹیمپلیٹ امیج جو 36×36 px ریٹینا بیکنگ اسٹور میں رینڈر ہوتی ہے)۔
- Scurry میں ٹانگوں کی جنبش ~1.0 تک اور ہلکی افقی جھٹک شامل ہوتی ہے؛ یہ کسی بھی موجودہ idle جنبش کے ساتھ اضافی طور پر لگتی ہے۔

Behavioral notes

- کان/ورکنگ کے لیے کوئی بیرونی CLI/بروکر ٹوگل نہیں؛ غیر ارادی فلَیپنگ سے بچنے کے لیے اسے ایپ کے اپنے سگنلز تک محدود رکھیں۔
- TTLs مختصر رکھیں (&lt;10s) تاکہ اگر کوئی کام اٹک جائے تو آئیکن تیزی سے بنیادی حالت میں واپس آ جائے۔
