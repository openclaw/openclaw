---
summary: "Reference CLI pour `openclaw dns` (assistants de decouverte a grande echelle)"
read_when:
  - Vous souhaitez une decouverte a grande echelle (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
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
