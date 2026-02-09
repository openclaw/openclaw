---
summary: "براؤزر آٹومیشن کے لیے دستی لاگ اِن + X/Twitter پر پوسٹنگ"
read_when:
  - آپ کو براؤزر آٹومیشن کے لیے سائٹس میں لاگ اِن کرنے کی ضرورت ہو
  - آپ X/Twitter پر اپڈیٹس پوسٹ کرنا چاہتے ہوں
title: "Browser Login"
---

# براؤزر لاگ اِن + X/Twitter پوسٹنگ

## دستی لاگ اِن (سفارش کردہ)

جب کسی سائٹ پر لاگ اِن درکار ہو تو **ہوسٹ** براؤزر پروفائل (openclaw براؤزر) میں **خود دستی طور پر سائن اِن کریں**۔

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

مرکزی براؤزر دستاویزات پر واپس جائیں: [Browser](/tools/browser)۔

## کون سا Chrome پروفائل استعمال ہوتا ہے؟

OpenClaw controls a **dedicated Chrome profile** (named `openclaw`, orange‑tinted UI). This is separate from your daily browser profile.

اس تک رسائی کے دو آسان طریقے:

1. **ایجنٹ سے براؤزر کھلوانے کو کہیں** اور پھر خود لاگ اِن کریں۔
2. **CLI کے ذریعے کھولیں**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

اگر آپ کے پاس متعدد پروفائلز ہوں تو `--browser-profile <name>` پاس کریں (بطورِ طے شدہ `openclaw` ہوتا ہے)۔

## X/Twitter: سفارش کردہ طریقۂ کار

- **پڑھنا/تلاش/تھریڈز:** **ہوسٹ** براؤزر استعمال کریں (دستی لاگ اِن)۔
- **اپڈیٹس پوسٹ کرنا:** **ہوسٹ** براؤزر استعمال کریں (دستی لاگ اِن)۔

## Sandboxing + ہوسٹ براؤزر رسائی

Sandboxed browser sessions are **more likely** to trigger bot detection. For X/Twitter (and other strict sites), prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

پھر ہوسٹ براؤزر کو ہدف بنائیں:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

یا اپڈیٹس پوسٹ کرنے والے ایجنٹ کے لیے sandboxing غیر فعال کر دیں۔
