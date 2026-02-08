---
summary: "`openclaw dns` के लिए CLI संदर्भ (वाइड-एरिया डिस्कवरी सहायक)"
read_when:
  - आप Tailscale + CoreDNS के माध्यम से वाइड-एरिया डिस्कवरी (DNS-SD) चाहते हैं
  - आप किसी कस्टम डिस्कवरी डोमेन (उदाहरण: openclaw.internal) के लिए स्प्लिट DNS सेट कर रहे हैं
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:53Z
---

# `openclaw dns`

वाइड-एरिया डिस्कवरी (Tailscale + CoreDNS) के लिए DNS सहायक। वर्तमान में macOS + Homebrew CoreDNS पर केंद्रित।

संबंधित:

- Gateway डिस्कवरी: [Discovery](/gateway/discovery)
- वाइड-एरिया डिस्कवरी विन्यास: [Configuration](/gateway/configuration)

## सेटअप

```bash
openclaw dns setup
openclaw dns setup --apply
```
