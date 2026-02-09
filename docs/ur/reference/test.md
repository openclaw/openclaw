---
summary: "ٹیسٹس کو مقامی طور پر (Vitest) کیسے چلایا جائے اور force/coverage موڈز کب استعمال کیے جائیں"
read_when:
  - ٹیسٹس چلانے یا درست کرنے کے دوران
title: "ٹیسٹس"
---

# ٹیسٹس

- مکمل ٹیسٹنگ کِٹ (سُوئٹس، لائیو، Docker): [Testing](/help/testing)

- 12. `pnpm test:force`: کسی بھی باقی رہ جانے والے گیٹ وے پروسس کو ختم کرتا ہے جو ڈیفالٹ کنٹرول پورٹ کو تھامے ہوئے ہو، پھر ایک الگ تھلگ گیٹ وے پورٹ کے ساتھ مکمل Vitest سوئٹ چلاتا ہے تاکہ سرور ٹیسٹ کسی چلتی ہوئی انسٹینس سے ٹکرا نہ جائیں۔ 13. اسے اس وقت استعمال کریں جب پچھلے گیٹ وے رن نے پورٹ 18789 کو مصروف چھوڑ دیا ہو۔

- 14. `pnpm test:coverage`: V8 کوریج کے ساتھ Vitest چلاتا ہے۔ 15. عالمی تھریش ہولڈز لائنز/برانچز/فنکشنز/اسٹیٹمنٹس کے لیے 70% ہیں۔ Coverage excludes integration-heavy entrypoints (CLI wiring, gateway/telegram bridges, webchat static server) to keep the target focused on unit-testable logic.

- `pnpm test:e2e`: gateway اینڈ ٹو اینڈ اسموک ٹیسٹس چلاتا ہے (ملٹی انسٹینس WS/HTTP/node جوڑی بنانا)۔

- `pnpm test:live`: Runs provider live tests (minimax/zai). 18. ان اسکیپ کرنے کے لیے API کیز اور `LIVE=1` (یا فراہم کنندہ کے مخصوص `*_LIVE_TEST=1`) درکار ہیں۔

## ماڈل لیٹنسی بینچ (مقامی کلیدیں)

اسکرپٹ: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

استعمال:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- اختیاری env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. 20. No punctuation or extra text.”

آخری رَن (2025-12-31، 20 رَنز):

- minimax میڈین 1279ms (کم از کم 1114، زیادہ سے زیادہ 2431)
- opus میڈین 2454ms (کم از کم 1224، زیادہ سے زیادہ 3170)

## آن بورڈنگ E2E (Docker)

Docker اختیاری ہے؛ یہ صرف کنٹینرائزڈ آن بورڈنگ اسموک ٹیسٹس کے لیے درکار ہے۔

صاف Linux کنٹینر میں مکمل کولڈ-اسٹارٹ فلو:

```bash
scripts/e2e/onboard-docker.sh
```

یہ اسکرپٹ pseudo-tty کے ذریعے انٹرایکٹو وزرڈ چلاتا ہے، کنفیگ/ورک اسپیس/سیشن فائلز کی تصدیق کرتا ہے، پھر gateway شروع کرتا ہے اور `openclaw health` چلاتا ہے۔

## QR امپورٹ اسموک (Docker)

یقینی بناتا ہے کہ `qrcode-terminal` Docker میں Node 22+ کے تحت لوڈ ہو:

```bash
pnpm test:docker:qr
```
