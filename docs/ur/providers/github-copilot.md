---
summary: "OpenClaw سے GitHub Copilot میں ڈیوائس فلو کے ذریعے سائن اِن کریں"
read_when:
  - آپ GitHub Copilot کو بطور ماڈل فراہم کنندہ استعمال کرنا چاہتے ہیں
  - آپ کو `openclaw models auth login-github-copilot` فلو درکار ہے
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot کیا ہے؟

GitHub Copilot، GitHub کا AI کوڈنگ اسسٹنٹ ہے۔ It provides access to Copilot
models for your GitHub account and plan. OpenClaw can use Copilot as a model
provider in two different ways.

## OpenClaw میں Copilot استعمال کرنے کے دو طریقے

### 1. بلٹ اِن GitHub Copilot فراہم کنندہ (`github-copilot`)

Use the native device-login flow to obtain a GitHub token, then exchange it for
Copilot API tokens when OpenClaw runs. This is the **default** and simplest path
because it does not require VS Code.

### 2. Copilot Proxy پلگ اِن (`copilot-proxy`)

Use the **Copilot Proxy** VS Code extension as a local bridge. OpenClaw talks to
the proxy’s `/v1` endpoint and uses the model list you configure there. Choose
this when you already run Copilot Proxy in VS Code or need to route through it.
You must enable the plugin and keep the VS Code extension running.

Use GitHub Copilot as a model provider (`github-copilot`). The login command runs
the GitHub device flow, saves an auth profile, and updates your config to use that
profile.

## CLI سیٹ اپ

```bash
openclaw models auth login-github-copilot
```

You'll be prompted to visit a URL and enter a one-time code. Keep the terminal
open until it completes.

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
