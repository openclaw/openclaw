---
summary: "CLI حوالہ برائے `openclaw doctor` (ہیلتھ چیکس + رہنمائی کے ساتھ مرمت)"
read_when:
  - آپ کو کنیکٹیویٹی/تصدیق کے مسائل ہیں اور رہنمائی کے ساتھ حل چاہتے ہیں
  - آپ نے اپڈیٹ کیا ہے اور ایک فوری جانچ چاہتے ہیں
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:57Z
---

# `openclaw doctor`

Gateway اور چینلز کے لیے ہیلتھ چیکس + فوری حل۔

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## مثالیں

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

نوٹس:

- انٹرایکٹو پرامپٹس (جیسے کی چین/ OAuth کے حل) صرف اس وقت چلتے ہیں جب stdin ایک TTY ہو اور `--non-interactive` **سیٹ نہ** ہو۔ ہیڈ لیس رنز (cron، Telegram، بغیر ٹرمینل) پرامپٹس کو چھوڑ دیں گے۔
- `--fix` (جو `--repair` کا عرف ہے) `~/.openclaw/openclaw.json.bak` میں ایک بیک اپ لکھتا ہے اور نامعلوم کنفیگ کیز کو ہٹا دیتا ہے، ہر ہٹانے کی فہرست بناتے ہوئے۔

## macOS: `launchctl` env اووررائیڈز

اگر آپ نے پہلے `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (یا `...PASSWORD`) چلایا تھا، تو وہ قدر آپ کی کنفیگ فائل پر اووررائیڈ ہو جاتی ہے اور مسلسل “غیر مجاز” کی غلطیوں کا سبب بن سکتی ہے۔

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
