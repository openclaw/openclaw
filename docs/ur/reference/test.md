---
summary: "ٹیسٹس کو مقامی طور پر (Vitest) کیسے چلایا جائے اور force/coverage موڈز کب استعمال کیے جائیں"
read_when:
  - ٹیسٹس چلانے یا درست کرنے کے دوران
title: "ٹیسٹس"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:41Z
---

# ٹیسٹس

- مکمل ٹیسٹنگ کِٹ (سُوئٹس، لائیو، Docker): [Testing](/help/testing)

- `pnpm test:force`: ڈیفالٹ کنٹرول پورٹ پر قابض کسی بھی باقی رہ جانے والے gateway عمل کو ختم کرتا ہے، پھر الگ تھلگ gateway پورٹ کے ساتھ مکمل Vitest سُوئٹ چلاتا ہے تاکہ سرور ٹیسٹس چلتی ہوئی انسٹینس سے ٹکرا نہ جائیں۔ جب پچھلا gateway رَن پورٹ 18789 کو مصروف چھوڑ دے تو اسے استعمال کریں۔
- `pnpm test:coverage`: V8 کوریج کے ساتھ Vitest چلاتا ہے۔ عالمی حدیں 70% لائنز/برانچز/فنکشنز/اسٹیٹمنٹس ہیں۔ کوریج میں انٹری پوائنٹس شامل نہیں کیے جاتے جو انٹیگریشن پر زیادہ منحصر ہوں (CLI وائرنگ، gateway/telegram برجز، ویب چیٹ اسٹیٹک سرور) تاکہ ہدف یونٹ ٹیسٹ کے قابل منطق پر مرکوز رہے۔
- `pnpm test:e2e`: gateway اینڈ ٹو اینڈ اسموک ٹیسٹس چلاتا ہے (ملٹی انسٹینس WS/HTTP/node جوڑی بنانا)۔
- `pnpm test:live`: فراہم کنندہ کے لائیو ٹیسٹس (minimax/zai) چلاتا ہے۔ API کلیدیں درکار ہیں اور اَن اسکیپ کرنے کے لیے `LIVE=1` (یا فراہم کنندہ مخصوص `*_LIVE_TEST=1`) ضروری ہے۔

## ماڈل لیٹنسی بینچ (مقامی کلیدیں)

اسکرپٹ: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

استعمال:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- اختیاری env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- ڈیفالٹ پرامپٹ: “ایک ہی لفظ کے ساتھ جواب دیں: ok۔ کوئی رموزِ اوقاف یا اضافی متن نہیں۔”

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
