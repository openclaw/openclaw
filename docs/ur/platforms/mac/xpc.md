---
summary: "OpenClaw ایپ، گیٹ وے نوڈ ٹرانسپورٹ، اور PeekabooBridge کے لیے macOS IPC آرکیٹیکچر"
read_when:
  - IPC کنٹریکٹس یا مینو بار ایپ IPC میں ترمیم کرتے وقت
title: "macOS IPC"
---

# OpenClaw macOS IPC آرکیٹیکچر

**Current model:** a local Unix socket connects the **node host service** to the **macOS app** for exec approvals + `system.run`. 21. دریافت/کنیکٹ چیکس کے لیے ایک `openclaw-mac` ڈیبگ CLI موجود ہے؛ ایجنٹ ایکشنز اب بھی Gateway WebSocket اور `node.invoke` کے ذریعے گزرتے ہیں۔ 22. UI آٹومیشن PeekabooBridge استعمال کرتی ہے۔

## اہداف

- ایک ہی GUI ایپ انسٹینس جو تمام TCC سے متعلق کام کی مالک ہو (نوٹیفیکیشنز، اسکرین ریکارڈنگ، مائیک، اسپیچ، AppleScript)۔
- آٹومیشن کے لیے مختصر سطح: Gateway + نوڈ کمانڈز، نیز UI آٹومیشن کے لیے PeekabooBridge۔
- قابلِ پیش گوئی اجازتیں: ہمیشہ ایک ہی سائنڈ بنڈل ID، launchd کے ذریعے لانچ، تاکہ TCC گرانٹس برقرار رہیں۔

## یہ کیسے کام کرتا ہے

### Gateway + نوڈ ٹرانسپورٹ

- ایپ Gateway (لوکل موڈ) چلاتی ہے اور اس سے بطورِ نوڈ کنیکٹ ہوتی ہے۔
- ایجنٹ ایکشنز `node.invoke` کے ذریعے انجام دیے جاتے ہیں (مثلاً `system.run`، `system.notify`، `canvas.*`)۔

### نوڈ سروس + ایپ IPC

- ایک ہیڈ لیس نوڈ ہوسٹ سروس Gateway WebSocket سے کنیکٹ ہوتی ہے۔
- `system.run` درخواستیں لوکل Unix ساکٹ کے ذریعے macOS ایپ کو فارورڈ کی جاتی ہیں۔
- ایپ UI سیاق میں exec انجام دیتی ہے، ضرورت ہو تو پرامپٹ کرتی ہے، اور آؤٹ پٹ واپس کرتی ہے۔

ڈایاگرام (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI آٹومیشن)

- UI آٹومیشن ایک الگ UNIX ساکٹ استعمال کرتی ہے جس کا نام `bridge.sock` ہے اور PeekabooBridge JSON پروٹوکول۔
- ہوسٹ ترجیحی ترتیب (کلائنٹ سائیڈ): Peekaboo.app → Claude.app → OpenClaw.app → لوکل ایگزیکیوشن۔
- سکیورٹی: برج ہوسٹس کے لیے اجازت یافتہ TeamID درکار ہے؛ DEBUG-صرف same-UID اسکیپ ہیچ `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo کنونشن) کے ذریعے محفوظ ہے۔
- دیکھیں: تفصیلات کے لیے [PeekabooBridge usage](/platforms/mac/peekaboo)۔

## عملی بہاؤ

- ری اسٹارٹ/ری بلڈ: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - موجودہ انسٹینسز کو ختم کرتا ہے
  - Swift بلڈ + پیکیج
  - LaunchAgent کو لکھتا/بوٹ اسٹرپ/کِک اسٹارٹ کرتا ہے
- سنگل انسٹینس: اگر اسی بنڈل ID کے ساتھ کوئی اور انسٹینس چل رہی ہو تو ایپ ابتدا ہی میں بند ہو جاتی ہے۔

## ہارڈننگ نوٹس

- تمام مراعات یافتہ سطحوں کے لیے TeamID میچ لازمی کرنے کو ترجیح دیں۔
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-صرف) لوکل ڈیولپمنٹ کے لیے same-UID کالرز کی اجازت دے سکتا ہے۔
- تمام مواصلات صرف لوکل رہتے ہیں؛ کوئی نیٹ ورک ساکٹس ایکسپوز نہیں کیے جاتے۔
- TCC پرامپٹس صرف GUI ایپ بنڈل سے شروع ہوتے ہیں؛ ری بلڈز کے دوران سائنڈ بنڈل ID کو مستحکم رکھیں۔
- IPC ہارڈننگ: ساکٹ موڈ `0600`، ٹوکن، peer-UID چیکس، HMAC چیلنج/ریسپانس، مختصر TTL۔
