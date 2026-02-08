---
summary: "Dokumentacja referencyjna CLI dla `openclaw dns` (narzędzia pomocnicze do wykrywania w sieci rozległej)"
read_when:
  - Chcesz wykrywanie w sieci rozległej (DNS-SD) przez Tailscale + CoreDNS
  - Konfigurujesz split DNS dla niestandardowej domeny wykrywania (przykład: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:51Z
---

# `openclaw dns`

Narzędzia pomocnicze DNS do wykrywania w sieci rozległej (Tailscale + CoreDNS). Obecnie skupione na macOS + Homebrew CoreDNS.

Powiązane:

- Wykrywanie Gateway: [Discovery](/gateway/discovery)
- Konfiguracja wykrywania w sieci rozległej: [Configuration](/gateway/configuration)

## Konfiguracja

```bash
openclaw dns setup
openclaw dns setup --apply
```
