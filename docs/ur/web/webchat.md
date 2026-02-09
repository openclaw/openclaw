---
summary: "لوپ بیک WebChat اسٹیٹک ہوسٹ اور چیٹ UI کے لیے Gateway WS کا استعمال"
read_when:
  - WebChat رسائی کی خرابیوں کا ازالہ یا کنفیگریشن کرتے وقت
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

حیثیت: macOS/iOS SwiftUI چیٹ UI براہِ راست Gateway WebSocket سے بات کرتا ہے۔

## یہ کیا ہے

- gateway کے لیے ایک نیٹو چیٹ UI (نہ کوئی ایمبیڈڈ براؤزر اور نہ ہی کوئی لوکل اسٹیٹک سرور)۔
- دیگر چینلز کی طرح ہی وہی سیشنز اور روٹنگ قواعد استعمال کرتا ہے۔
- تعین شدہ روٹنگ: جوابات ہمیشہ WebChat پر ہی واپس آتے ہیں۔

## فوری آغاز

1. gateway شروع کریں۔
2. WebChat UI (macOS/iOS ایپ) یا Control UI کے چیٹ ٹیب کو کھولیں۔
3. یقینی بنائیں کہ gateway کی تصدیق کنفیگر کی گئی ہے (بطورِ طے شدہ لازم ہے، حتیٰ کہ loopback پر بھی)۔

## یہ کیسے کام کرتا ہے (رویہ)

- UI، Gateway WebSocket سے جڑتا ہے اور `chat.history`، `chat.send`، اور `chat.inject` استعمال کرتا ہے۔
- `chat.inject` ایک اسسٹنٹ نوٹ کو براہِ راست ٹرانسکرپٹ میں شامل کرتا ہے اور اسے UI تک براڈکاسٹ کرتا ہے (کوئی ایجنٹ رن نہیں)۔
- ہسٹری ہمیشہ gateway سے حاصل کی جاتی ہے (کوئی لوکل فائل واچنگ نہیں)۔
- اگر gateway قابلِ رسائی نہ ہو تو WebChat صرف مطالعہ کے لیے ہوتا ہے۔

## ریموٹ استعمال

- ریموٹ موڈ SSH/Tailscale کے ذریعے gateway WebSocket کو ٹنل کرتا ہے۔
- آپ کو علیحدہ WebChat سرور چلانے کی ضرورت نہیں۔

## کنفیگریشن حوالہ (WebChat)

مکمل کنفیگریشن: [Configuration](/gateway/configuration)

چینل کے اختیارات:

- `webchat.*` کے لیے کوئی مخصوص بلاک نہیں۔ WebChat نیچے دی گئی gateway endpoint اور auth سیٹنگز استعمال کرتا ہے۔

متعلقہ عالمی اختیارات:

- `gateway.port`، `gateway.bind`: WebSocket ہوسٹ/پورٹ۔
- `gateway.auth.mode`، `gateway.auth.token`، `gateway.auth.password`: WebSocket تصدیق۔
- `gateway.remote.url`، `gateway.remote.token`، `gateway.remote.password`: ریموٹ gateway ہدف۔
- `session.*`: سیشن اسٹوریج اور مرکزی کلید کے طے شدہ اقدار۔
