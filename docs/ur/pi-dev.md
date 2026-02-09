---
title: "Pi ڈیولپمنٹ ورک فلو"
---

# Pi ڈیولپمنٹ ورک فلو

یہ گائیڈ OpenClaw میں Pi انضمام پر کام کرنے کے لیے ایک معقول ورک فلو کا خلاصہ پیش کرتی ہے۔

## ٹائپ چیکنگ اور لنٹنگ

- ٹائپ چیک اور بلڈ: `pnpm build`
- لنٹ: `pnpm lint`
- فارمیٹ چیک: `pnpm format`
- پش کرنے سے پہلے مکمل گیٹ: `pnpm lint && pnpm build && pnpm test`

## Pi ٹیسٹس چلانا

Pi انضمام کے ٹیسٹ سیٹ کے لیے مخصوص اسکرپٹ استعمال کریں:

```bash
scripts/pi/run-tests.sh
```

حقیقی فراہم کنندہ کے رویّے کو آزمانے والا لائیو ٹیسٹ شامل کرنے کے لیے:

```bash
scripts/pi/run-tests.sh --live
```

یہ اسکرپٹ درج ذیل گلوبز کے ذریعے Pi سے متعلق تمام یونٹ ٹیسٹس چلاتا ہے:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## دستی جانچ

سفارش کردہ فلو:

- گیٹ وے کو ڈیو موڈ میں چلائیں:
  - `pnpm gateway:dev`
- ایجنٹ کو براہِ راست ٹرگر کریں:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- انٹرایکٹو ڈیبگنگ کے لیے TUI استعمال کریں:
  - `pnpm tui`

ٹول کال کے رویّے کے لیے، `read` یا `exec` ایکشن کے لیے پرامپٹ کریں تاکہ آپ ٹول اسٹریمنگ اور پے لوڈ ہینڈلنگ دیکھ سکیں۔

## کلین سلیٹ ری سیٹ

State lives under the OpenClaw state directory. Default is `~/.openclaw`. If `OPENCLAW_STATE_DIR` is set, use that directory instead.

ہر چیز ری سیٹ کرنے کے لیے:

- کنفیگ کے لیے `openclaw.json`
- تصدیقی پروفائلز اور ٹوکنز کے لیے `credentials/`
- ایجنٹ سیشن ہسٹری کے لیے `agents/<agentId>/sessions/`
- سیشن انڈیکس کے لیے `agents/<agentId>/sessions.json`
- اگر لیگیسی راستے موجود ہوں تو `sessions/`
- اگر آپ خالی ورک اسپیس چاہتے ہیں تو `workspace/`

If you only want to reset sessions, delete `agents/<agentId>/sessions/` and `agents/<agentId>/sessions.json` for that agent. Keep `credentials/` if you do not want to reauthenticate.

## مراجع

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
