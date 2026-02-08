---
summary: "CLI-Referenz für `openclaw dns` (Hilfen für Weitbereichs-Discovery)"
read_when:
  - Sie möchten Weitbereichs-Discovery (DNS-SD) über Tailscale + CoreDNS nutzen
  - Sie richten Split-DNS für eine benutzerdefinierte Discovery-Domain ein (Beispiel: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:37Z
---

# `openclaw dns`

DNS-Hilfen für Weitbereichs-Discovery (Tailscale + CoreDNS). Derzeit mit Fokus auf macOS + Homebrew CoreDNS.

Verwandt:

- Gateway-Discovery: [Discovery (Erkennung)](/gateway/discovery)
- Konfiguration für Weitbereichs-Discovery: [Konfiguration](/gateway/configuration)

## Einrichtung

```bash
openclaw dns setup
openclaw dns setup --apply
```
