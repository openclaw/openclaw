---
summary: "CLI-referens för `openclaw dns` (hjälpverktyg för vidsträckt Discovery)"
read_when:
  - Du vill ha vidsträckt Discovery (DNS-SD) via Tailscale + CoreDNS
  - Du konfigurerar split DNS för en anpassad Discovery-domän (exempel: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:40Z
---

# `openclaw dns`

DNS-hjälpverktyg för vidsträckt Discovery (Tailscale + CoreDNS). För närvarande fokuserat på macOS + Homebrew CoreDNS.

Relaterat:

- Gateway Discovery: [Discovery](/gateway/discovery)
- Konfiguration för vidsträckt Discovery: [Configuration](/gateway/configuration)

## Konfigurering

```bash
openclaw dns setup
openclaw dns setup --apply
```
