---
summary: "مرجع CLI للأمر `openclaw dns` (مساعدات الاكتشاف على نطاق واسع)"
read_when:
  - تريد الاكتشاف على نطاق واسع (DNS-SD) عبر Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
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
