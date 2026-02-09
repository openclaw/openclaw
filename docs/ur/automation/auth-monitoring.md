---
summary: "ماڈل فراہم کنندگان کے لیے OAuth کی معیاد ختم ہونے کی نگرانی کریں"
read_when:
  - تصدیق کی معیاد ختم ہونے کی نگرانی یا الرٹس سیٹ کرتے وقت
  - Claude Code / Codex OAuth ریفریش چیکس کو خودکار بناتے وقت
title: "Auth نگرانی"
---

# Auth نگرانی

OpenClaw `openclaw models status` کے ذریعے OAuth کی معیاد ختم ہونے کی صحت ظاہر کرتا ہے۔ اسے آٹومیشن اور الرٹنگ کے لیے استعمال کریں؛ فون ورک فلو کے لیے اسکرپٹس اختیاری اضافے ہیں۔

## ترجیحی: CLI چیک (پورٹیبل)

```bash
openclaw models status --check
```

ایگزٹ کوڈز:

- `0`: OK
- `1`: اسناد کی میعاد ختم ہو چکی ہے یا موجود نہیں
- `2`: جلد ختم ہونے والی (24 گھنٹوں کے اندر)

یہ cron/systemd میں کام کرتا ہے اور کسی اضافی اسکرپٹس کی ضرورت نہیں۔

## اختیاری اسکرپٹس (ops / فون ورک فلو)

These live under `scripts/` and are **optional**. یہ گیٹ وے ہوسٹ تک SSH رسائی فرض کرتے ہیں اور systemd + Termux کے لیے ٹیون کیے گئے ہیں۔

- `scripts/claude-auth-status.sh` اب `openclaw models status --json` کو
  واحد ماخذِ حقیقت کے طور پر استعمال کرتا ہے (اگر CLI دستیاب نہ ہو تو براہِ راست فائل ریڈز پر واپس جاتا ہے)،
  اس لیے ٹائمرز کے لیے `PATH` پر `openclaw` برقرار رکھیں۔
- `scripts/auth-monitor.sh`: cron/systemd ٹائمر ہدف؛ الرٹس بھیجتا ہے (ntfy یا فون)۔
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd یوزر ٹائمر۔
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw تصدیق چیکر (full/json/simple)۔
- `scripts/mobile-reauth.sh`: SSH کے ذریعے رہنمائی شدہ دوبارہ تصدیق فلو۔
- `scripts/termux-quick-auth.sh`: ون‑ٹیپ ویجیٹ اسٹیٹس + auth URL کھولیں۔
- `scripts/termux-auth-widget.sh`: مکمل رہنمائی شدہ ویجیٹ فلو۔
- `scripts/termux-sync-widget.sh`: Claude Code اسناد → OpenClaw ہم وقت سازی۔

اگر آپ کو فون خودکاری یا systemd ٹائمرز کی ضرورت نہیں، تو ان اسکرپٹس کو چھوڑ دیں۔
