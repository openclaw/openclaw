---
summary: "CLI حوالہ برائے `openclaw dns` (وسیع علاقائی ڈسکوری معاونین)"
read_when:
  - آپ Tailscale + CoreDNS کے ذریعے وسیع علاقائی ڈسکوری (DNS-SD) چاہتے ہیں
  - آپ کسی حسبِ ضرورت ڈسکوری ڈومین کے لیے اسپلِٹ DNS سیٹ اپ کر رہے ہیں (مثال: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:54Z
---

# `openclaw dns`

وسیع علاقائی ڈسکوری کے لیے DNS معاونین (Tailscale + CoreDNS)۔ فی الحال macOS + Homebrew CoreDNS پر مرکوز ہے۔

متعلقہ:

- Gateway ڈسکوری: [Discovery](/gateway/discovery)
- وسیع علاقائی ڈسکوری کنفیگ: [Configuration](/gateway/configuration)

## سیٹ اپ

```bash
openclaw dns setup
openclaw dns setup --apply
```
