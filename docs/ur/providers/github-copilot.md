---
summary: "OpenClaw سے GitHub Copilot میں ڈیوائس فلو کے ذریعے سائن اِن کریں"
read_when:
  - آپ GitHub Copilot کو بطور ماڈل فراہم کنندہ استعمال کرنا چاہتے ہیں
  - آپ کو `openclaw models auth login-github-copilot` فلو درکار ہے
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:32Z
---

# GitHub Copilot

## GitHub Copilot کیا ہے؟

GitHub Copilot، GitHub کا AI کوڈنگ اسسٹنٹ ہے۔ یہ آپ کے GitHub اکاؤنٹ اور پلان کے لیے Copilot
ماڈلز تک رسائی فراہم کرتا ہے۔ OpenClaw، Copilot کو بطور ماڈل فراہم کنندہ دو مختلف طریقوں سے استعمال کر سکتا ہے۔

## OpenClaw میں Copilot استعمال کرنے کے دو طریقے

### 1) بلٹ اِن GitHub Copilot فراہم کنندہ (`github-copilot`)

نیٹو ڈیوائس-لاگ اِن فلو استعمال کریں تاکہ GitHub ٹوکن حاصل کیا جا سکے، پھر جب OpenClaw چلتا ہے تو اسے Copilot API ٹوکنز کے ساتھ ایکسچینج کیا جاتا ہے۔ یہ **بطورِ طے شدہ** اور سب سے سادہ راستہ ہے کیونکہ اس میں VS Code درکار نہیں ہوتا۔

### 2) Copilot Proxy پلگ اِن (`copilot-proxy`)

**Copilot Proxy** VS Code ایکسٹینشن کو بطور مقامی پل استعمال کریں۔ OpenClaw، پراکسی کے `/v1` اینڈ پوائنٹ سے بات کرتا ہے اور وہاں کنفیگر کی گئی ماڈل فہرست استعمال کرتا ہے۔ یہ تب منتخب کریں جب آپ پہلے ہی VS Code میں Copilot Proxy چلا رہے ہوں یا اس کے ذریعے روٹنگ درکار ہو۔ آپ کو پلگ اِن فعال کرنا ہوگا اور VS Code ایکسٹینشن کو چلتا رکھنا ہوگا۔

GitHub Copilot کو بطور ماڈل فراہم کنندہ استعمال کریں (`github-copilot`)۔ لاگ اِن کمانڈ GitHub ڈیوائس فلو چلاتی ہے، ایک auth پروفائل محفوظ کرتی ہے، اور آپ کی کنفیگ کو اس پروفائل کے استعمال کے لیے اپ ڈیٹ کرتی ہے۔

## CLI سیٹ اپ

```bash
openclaw models auth login-github-copilot
```

آپ سے ایک URL پر جانے اور ایک وقتی کوڈ درج کرنے کے لیے کہا جائے گا۔ تکمیل تک ٹرمینل کھلا رکھیں۔

### اختیاری فلیگز

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## بطورِ طے شدہ ماڈل سیٹ کریں

```bash
openclaw models set github-copilot/gpt-4o
```

### کنفیگ ٹکڑا

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## نوٹس

- انٹرایکٹو TTY درکار ہے؛ اسے براہِ راست ٹرمینل میں چلائیں۔
- Copilot ماڈلز کی دستیابی آپ کے پلان پر منحصر ہے؛ اگر کوئی ماڈل مسترد ہو جائے تو
  کسی دوسرے ID کو آزمائیں (مثال کے طور پر `github-copilot/gpt-4.1`)۔
- لاگ اِن، auth پروفائل اسٹور میں GitHub ٹوکن محفوظ کرتا ہے اور جب OpenClaw چلتا ہے تو اسے
  Copilot API ٹوکن کے ساتھ ایکسچینج کرتا ہے۔
