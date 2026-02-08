---
summary: "CLI-reference for `openclaw dns` (hjælpere til wide-area discovery)"
read_when:
  - Du vil have wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - Du er ved at sætte split DNS op for et brugerdefineret discovery-domæne (eksempel: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:59Z
---

# `openclaw dns`

DNS-hjælpere til wide-area discovery (Tailscale + CoreDNS). I øjeblikket med fokus på macOS + Homebrew CoreDNS.

Relateret:

- Gateway discovery: [Discovery](/gateway/discovery)
- Konfiguration af wide-area discovery: [Configuration](/gateway/configuration)

## Opsætning

```bash
openclaw dns setup
openclaw dns setup --apply
```
