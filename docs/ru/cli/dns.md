---
summary: "Справочник CLI для `openclaw dns` (вспомогательные средства обнаружения в глобальной сети)"
read_when:
  - Вам требуется обнаружение в глобальной сети (DNS-SD) через Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

Вспомогательные средства DNS для обнаружения в глобальной сети (Tailscale + CoreDNS). В настоящее время ориентированы на macOS + Homebrew CoreDNS.

Связанное:

- Обнаружение Gateway (шлюз): [Discovery](/gateway/discovery)
- Конфигурация обнаружения в глобальной сети: [Configuration](/gateway/configuration)

## Настройка

```bash
openclaw dns setup
openclaw dns setup --apply
```
