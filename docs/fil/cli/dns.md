---
summary: "Sanggunian ng CLI para sa `openclaw dns` (mga helper para sa wide-area discovery)"
read_when:
  - Gusto mo ng wide-area discovery (DNS-SD) sa pamamagitan ng Tailscale + CoreDNS
  - Nagse-set up ka ng split DNS para sa isang custom na discovery domain (halimbawa: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:13Z
---

# `openclaw dns`

Mga DNS helper para sa wide-area discovery (Tailscale + CoreDNS). Kasalukuyang nakatuon sa macOS + Homebrew CoreDNS.

Kaugnay:

- Gateway discovery: [Discovery](/gateway/discovery)
- Config ng wide-area discovery: [Configuration](/gateway/configuration)

## Setup

```bash
openclaw dns setup
openclaw dns setup --apply
```
