---
summary: "`openclaw dns` के लिए CLI संदर्भ (वाइड-एरिया डिस्कवरी सहायक)"
read_when:
  - आप Tailscale + CoreDNS के माध्यम से वाइड-एरिया डिस्कवरी (DNS-SD) चाहते हैं
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

DNS helpers for wide-area discovery (Tailscale + CoreDNS). Currently focused on macOS + Homebrew CoreDNS.

संबंधित:

- Gateway डिस्कवरी: [Discovery](/gateway/discovery)
- वाइड-एरिया डिस्कवरी विन्यास: [Configuration](/gateway/configuration)

## सेटअप

```bash
openclaw dns setup
openclaw dns setup --apply
```
