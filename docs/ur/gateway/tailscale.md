---
summary: "Gateway ڈیش بورڈ کے لیے مربوط Tailscale Serve/Funnel"
read_when:
  - لوکل ہوسٹ سے باہر Gateway کنٹرول UI کو ظاہر کرنا
  - tailnet یا عوامی ڈیش بورڈ رسائی کو خودکار بنانا
title: "Tailscale"
x-i18n:
  source_path: gateway/tailscale.md
  source_hash: c4842b10848d4fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:26Z
---

# Tailscale (Gateway ڈیش بورڈ)

OpenClaw خودکار طور پر Tailscale **Serve** (tailnet) یا **Funnel** (عوامی) کو
Gateway (گیٹ وے) ڈیش بورڈ اور WebSocket پورٹ کے لیے کنفیگر کر سکتا ہے۔ اس سے Gateway
local loopback پر بندھا رہتا ہے جبکہ Tailscale HTTPS، روٹنگ، اور (Serve کے لیے)
شناختی ہیڈرز فراہم کرتا ہے۔

## Modes

- `serve`: Tailnet-only Serve بذریعہ `tailscale serve`. gateway `127.0.0.1` پر ہی رہتا ہے۔
- `funnel`: عوامی HTTPS بذریعہ `tailscale funnel`. OpenClaw کو مشترکہ پاس ورڈ درکار ہے۔
- `off`: ڈیفالٹ (کوئی Tailscale خودکاری نہیں)۔

## Auth

ہینڈشیک کو کنٹرول کرنے کے لیے `gateway.auth.mode` سیٹ کریں:

- `token` (جب `OPENCLAW_GATEWAY_TOKEN` سیٹ ہو تو بطورِ طے شدہ)
- `password` (مشترکہ خفیہ `OPENCLAW_GATEWAY_PASSWORD` یا کنفیگ کے ذریعے)

جب `tailscale.mode = "serve"` اور `gateway.auth.allowTailscale`، `true` ہو،
تو درست Serve پروکسی درخواستیں Tailscale شناختی ہیڈرز
(`tailscale-user-login`) کے ذریعے بغیر ٹوکن/پاس ورڈ فراہم کیے تصدیق کر سکتی ہیں۔ OpenClaw
شناخت کی توثیق اس طرح کرتا ہے کہ `x-forwarded-for` ایڈریس کو مقامی Tailscale
ڈیمن (`tailscale whois`) کے ذریعے resolve کر کے ہیڈر سے ملاتا ہے، پھر اسے قبول کرتا ہے۔
OpenClaw کسی درخواست کو صرف اسی صورت Serve سمجھتا ہے جب وہ loopback سے آئے اور
Tailscale کے `x-forwarded-for`, `x-forwarded-proto`, اور `x-forwarded-host`
ہیڈرز موجود ہوں۔
واضح اسناد لازم کرنے کے لیے `gateway.auth.allowTailscale: false` سیٹ کریں یا
`gateway.auth.mode: "password"` کو مجبور کریں۔

## Config examples

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

کھولیں: `https://<magicdns>/` (یا آپ کے کنفیگر کردہ `gateway.controlUi.basePath`)

### Tailnet-only (Tailnet IP پر bind)

جب آپ چاہتے ہوں کہ Gateway براہِ راست Tailnet IP پر سنے (Serve/Funnel کے بغیر) تو یہ استعمال کریں۔

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

کسی دوسرے Tailnet ڈیوائس سے کنیکٹ کریں:

- کنٹرول UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

نوٹ: loopback (`http://127.0.0.1:18789`) اس موڈ میں **کام نہیں** کرے گا۔

### عوامی انٹرنیٹ (Funnel + مشترکہ پاس ورڈ)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

ڈسک پر پاس ورڈ محفوظ کرنے کے بجائے `OPENCLAW_GATEWAY_PASSWORD` کو ترجیح دیں۔

## CLI examples

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel کے لیے `tailscale` CLI کا انسٹال اور لاگ اِن ہونا ضروری ہے۔
- `tailscale.mode: "funnel"` عوامی ایکسپوژر سے بچنے کے لیے اس وقت تک شروع نہیں ہوتا جب تک auth موڈ `password` نہ ہو۔
- اگر آپ چاہتے ہیں کہ OpenClaw شٹ ڈاؤن پر `tailscale serve`
  یا `tailscale funnel` کنفیگریشن کو واپس لے، تو `gateway.tailscale.resetOnExit` سیٹ کریں۔
- `gateway.bind: "tailnet"` براہِ راست Tailnet bind ہے (نہ HTTPS، نہ Serve/Funnel)۔
- `gateway.bind: "auto"` loopback کو ترجیح دیتا ہے؛ اگر Tailnet-only چاہیے تو `tailnet` استعمال کریں۔
- Serve/Funnel صرف **Gateway کنٹرول UI + WS** کو ایکسپوز کرتے ہیں۔ نوڈز
  اسی Gateway WS اینڈپوائنٹ کے ذریعے کنیکٹ ہوتے ہیں، اس لیے Serve نوڈ رسائی کے لیے کام کر سکتا ہے۔

## Browser control (ریموٹ Gateway + لوکل براؤزر)

اگر آپ Gateway ایک مشین پر چلا رہے ہیں لیکن کسی دوسری مشین پر براؤزر کنٹرول کرنا چاہتے ہیں،
تو براؤزر والی مشین پر ایک **node host** چلائیں اور دونوں کو ایک ہی tailnet پر رکھیں۔
Gateway براؤزر ایکشنز کو نوڈ تک پروکسی کرے گا؛ کسی علیحدہ کنٹرول سرور یا Serve URL کی ضرورت نہیں۔

براؤزر کنٹرول کے لیے Funnel سے پرہیز کریں؛ نوڈ pairing کو آپریٹر رسائی کے طور پر سمجھیں۔

## Tailscale پیشگی تقاضے + حدود

- Serve کے لیے آپ کے tailnet پر HTTPS فعال ہونا ضروری ہے؛ اگر غائب ہو تو CLI اشارہ دیتا ہے۔
- Serve Tailscale شناختی ہیڈرز داخل کرتا ہے؛ Funnel نہیں کرتا۔
- Funnel کے لیے Tailscale v1.38.3+، MagicDNS، HTTPS فعال ہونا، اور funnel نوڈ ایٹریبیوٹ درکار ہے۔
- Funnel TLS پر صرف `443`, `8443`, اور `10000` پورٹس کی حمایت کرتا ہے۔
- macOS پر Funnel کے لیے اوپن سورس Tailscale ایپ ویریئنٹ درکار ہے۔

## Learn more

- Tailscale Serve جائزہ: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` کمانڈ: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel جائزہ: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` کمانڈ: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
