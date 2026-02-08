---
summary: "Gateway ویب سطحیں: کنٹرول UI، بائنڈ موڈز، اور سکیورٹی"
read_when:
  - آپ Tailscale کے ذریعے Gateway تک رسائی چاہتے ہیں
  - آپ براؤزر کنٹرول UI اور کنفیگ ایڈیٹنگ چاہتے ہیں
title: "ویب"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:47Z
---

# ویب (Gateway)

Gateway، Gateway WebSocket کے اسی پورٹ سے ایک چھوٹا **براؤزر کنٹرول UI** (Vite + Lit) فراہم کرتا ہے:

- بطورِ طے شدہ: `http://<host>:18789/`
- اختیاری سابقہ: `gateway.controlUi.basePath` سیٹ کریں (مثلاً `/openclaw`)

صلاحیتیں [کنٹرول UI](/web/control-ui) میں موجود ہیں۔
یہ صفحہ بائنڈ موڈز، سکیورٹی، اور ویب پر سامنے آنے والی سطحوں پر توجہ دیتا ہے۔

## ویب ہُکس

جب `hooks.enabled=true` ہو، تو Gateway اسی HTTP سرور پر ایک چھوٹا ویب ہُک اینڈپوائنٹ بھی فراہم کرتا ہے۔
تصدیق اور پےلوڈز کے لیے [Gateway کنفیگریشن](/gateway/configuration) → `hooks` دیکھیں۔

## کنفیگ (بطورِ طے شدہ فعال)

کنٹرول UI بطورِ طے شدہ **فعال** ہوتا ہے جب اثاثے موجود ہوں (`dist/control-ui`)۔
آپ اسے کنفیگ کے ذریعے کنٹرول کر سکتے ہیں:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale رسائی

### Integrated Serve (سفارش کردہ)

Gateway کو loopback پر رکھیں اور Tailscale Serve کے ذریعے اسے پراکسی کریں:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

پھر gateway شروع کریں:

```bash
openclaw gateway
```

کھولیں:

- `https://<magicdns>/` (یا آپ کی کنفیگر کردہ `gateway.controlUi.basePath`)

### Tailnet بائنڈ + ٹوکن

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

پھر gateway شروع کریں (non-loopback بائنڈز کے لیے ٹوکن درکار ہے):

```bash
openclaw gateway
```

کھولیں:

- `http://<tailscale-ip>:18789/` (یا آپ کی کنفیگر کردہ `gateway.controlUi.basePath`)

### عوامی انٹرنیٹ (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## سکیورٹی نوٹس

- Gateway تصدیق بطورِ طے شدہ درکار ہے (ٹوکن/پاس ورڈ یا Tailscale شناختی ہیڈرز)۔
- non-loopback بائنڈز اب بھی **لازم** طور پر مشترکہ ٹوکن/پاس ورڈ چاہتے ہیں (`gateway.auth` یا env)۔
- وزارڈ بطورِ طے شدہ ایک gateway ٹوکن تیار کرتا ہے (loopback پر بھی)۔
- UI `connect.params.auth.token` یا `connect.params.auth.password` بھیجتا ہے۔
- کنٹرول UI اینٹی کلک جیکنگ ہیڈرز بھیجتا ہے اور صرف same-origin براؤزر
  WebSocket کنکشنز قبول کرتا ہے، الا یہ کہ `gateway.controlUi.allowedOrigins` سیٹ ہو۔
- Serve کے ساتھ، Tailscale شناختی ہیڈرز اس وقت تصدیق پوری کر سکتے ہیں جب
  `gateway.auth.allowTailscale`، `true` ہو (ٹوکن/پاس ورڈ درکار نہیں)۔ واضح اسناد لازم کرنے کے لیے
  `gateway.auth.allowTailscale: false` سیٹ کریں۔ [Tailscale](/gateway/tailscale) اور [سکیورٹی](/gateway/security) دیکھیں۔
- `gateway.tailscale.mode: "funnel"` کے لیے `gateway.auth.mode: "password"` (مشترکہ پاس ورڈ) درکار ہے۔

## UI بنانا

Gateway جامد فائلیں `dist/control-ui` سے فراہم کرتا ہے۔ انہیں اس طرح بنائیں:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
