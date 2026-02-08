---
summary: "CLI-referentie voor `openclaw dns` (helpers voor wide-area discovery)"
read_when:
  - Je wilt wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - Je stelt split DNS in voor een aangepast discovery-domein (voorbeeld: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:06Z
---

# `openclaw dns`

DNS-helpers voor wide-area discovery (Tailscale + CoreDNS). Momenteel gericht op macOS + Homebrew CoreDNS.

Gerelateerd:

- Gateway discovery: [Discovery](/gateway/discovery)
- Wide-area discovery-configuratie: [Configuration](/gateway/configuration)

## Installatie

```bash
openclaw dns setup
openclaw dns setup --apply
```
