---
summary: "CLI-referens för `openclaw dns` (hjälpverktyg för vidsträckt Discovery)"
read_when:
  - Du vill ha vidsträckt Discovery (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

DNS-hjälpare för wide-area upptäckt (Tailscale + CoreDNS). För närvarande fokuserade på macOS + Homebrew CoreDNS.

Relaterat:

- Gateway Discovery: [Discovery](/gateway/discovery)
- Konfiguration för vidsträckt Discovery: [Configuration](/gateway/configuration)

## Konfigurering

```bash
openclaw dns setup
openclaw dns setup --apply
```
