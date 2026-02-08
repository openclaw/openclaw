---
summary: "مرجع CLI للأمر `openclaw dns` (مساعدات الاكتشاف على نطاق واسع)"
read_when:
  - "تريد الاكتشاف على نطاق واسع (DNS-SD) عبر Tailscale + CoreDNS"
  - "تقوم بإعداد DNS مُقسّم لنطاق اكتشاف مخصّص (مثال: openclaw.internal)"
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:55Z
---

# `openclaw dns`

مساعدات DNS للاكتشاف على نطاق واسع (Tailscale + CoreDNS). تتركّز حاليًا على macOS + Homebrew CoreDNS.

ذو صلة:

- اكتشاف Gateway: [الاكتشاف](/gateway/discovery)
- تهيئة الاكتشاف على نطاق واسع: [التهيئة](/gateway/configuration)

## الإعداد

```bash
openclaw dns setup
openclaw dns setup --apply
```
