---
summary: "Gateway ویب سطحیں: کنٹرول UI، بائنڈ موڈز، اور سکیورٹی"
read_when:
  - آپ Tailscale کے ذریعے Gateway تک رسائی چاہتے ہیں
  - آپ براؤزر کنٹرول UI اور کنفیگ ایڈیٹنگ چاہتے ہیں
title: "ویب"
---

# ویب (Gateway)

Gateway، Gateway WebSocket کے اسی پورٹ سے ایک چھوٹا **براؤزر کنٹرول UI** (Vite + Lit) فراہم کرتا ہے:

- بطورِ طے شدہ: `http://<host>:18789/`
- اختیاری سابقہ: `gateway.controlUi.basePath` سیٹ کریں (مثلاً `/openclaw`)

صلاحیتیں [Control UI](/web/control-ui) میں موجود ہیں۔
یہ صفحہ bind موڈز، سیکیورٹی، اور ویب پر ظاہر ہونے والی سرفیسز پر توجہ دیتا ہے۔

## ویب ہُکس

جب `hooks.enabled=true` ہو تو Gateway اسی HTTP سرور پر ایک چھوٹا webhook endpoint بھی فراہم کرتا ہے۔
تصدیق اور payloads کے لیے [Gateway configuration](/gateway/configuration) → `hooks` دیکھیں۔

## کنفیگ (بطورِ طے شدہ فعال)

جب assets موجود ہوں (`dist/control-ui`) تو Control UI **بطورِ ڈیفالٹ فعال** ہوتا ہے۔
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
- Serve کے ساتھ، جب `gateway.auth.allowTailscale` `true` ہو تو Tailscale شناختی ہیڈرز تصدیق کو پورا کر سکتے ہیں (token/password درکار نہیں)۔ واضح اسناد کی ضرورت کے لیے `gateway.auth.allowTailscale: false` سیٹ کریں۔ [Tailscale](/gateway/tailscale) اور [Security](/gateway/security) دیکھیں۔
- `gateway.tailscale.mode: "funnel"` کے لیے `gateway.auth.mode: "password"` (مشترکہ پاس ورڈ) درکار ہے۔

## UI بنانا

Gateway جامد فائلیں `dist/control-ui` سے فراہم کرتا ہے۔ انہیں اس طرح بنائیں:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
