---
summary: "Справочник CLI для `openclaw dns` (вспомогательные средства обнаружения в глобальной сети)"
read_when:
  - Вам требуется обнаружение в глобальной сети (DNS-SD) через Tailscale + CoreDNS
  - Вы настраиваете split DNS для пользовательского домена обнаружения (пример: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:11Z
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
