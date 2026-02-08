---
summary: "Referencia de la CLI para `openclaw dns` (ayudantes de descubrimiento de área amplia)"
read_when:
  - Quiere descubrimiento de área amplia (DNS-SD) mediante Tailscale + CoreDNS
  - Está configurando DNS dividido para un dominio de descubrimiento personalizado (ejemplo: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:52Z
---

# `openclaw dns`

Ayudantes de DNS para el descubrimiento de área amplia (Tailscale + CoreDNS). Actualmente enfocados en macOS + Homebrew CoreDNS.

Relacionado:

- Descubrimiento del Gateway: [Discovery](/gateway/discovery)
- Configuración de descubrimiento de área amplia: [Configuration](/gateway/configuration)

## Configuración

```bash
openclaw dns setup
openclaw dns setup --apply
```
