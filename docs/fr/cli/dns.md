---
summary: "Reference CLI pour `openclaw dns` (assistants de decouverte a grande echelle)"
read_when:
  - Vous souhaitez une decouverte a grande echelle (DNS-SD) via Tailscale + CoreDNS
  - Vous mettez en place un DNS fractionne pour un domaine de decouverte personnalise (exemple: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:54Z
---

# `openclaw dns`

Assistants DNS pour la decouverte a grande echelle (Tailscale + CoreDNS). Actuellement axes sur macOS + CoreDNS via Homebrew.

Associe :

- Decouverte de la Gateway (passerelle) : [Decouverte](/gateway/discovery)
- Configuration de la decouverte a grande echelle : [Configuration](/gateway/configuration)

## Setup

```bash
openclaw dns setup
openclaw dns setup --apply
```
