---
summary: "Referência da CLI para `openclaw dns` (auxiliares de descoberta de área ampla)"
read_when:
  - Você quer descoberta de área ampla (DNS-SD) via Tailscale + CoreDNS
  - Você está configurando DNS dividido para um domínio de descoberta personalizado (exemplo: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:14Z
---

# `openclaw dns`

Auxiliares de DNS para descoberta de área ampla (Tailscale + CoreDNS). Atualmente focado em macOS + CoreDNS via Homebrew.

Relacionado:

- Descoberta do Gateway: [Discovery](/gateway/discovery)
- Configuração de descoberta de área ampla: [Configuration](/gateway/configuration)

## Configuração

```bash
openclaw dns setup
openclaw dns setup --apply
```
