---
summary: "Referência da CLI para `openclaw reset` (redefine o estado/configuração local)"
read_when:
  - Você quer apagar o estado local mantendo a CLI instalada
  - Você quer um dry-run do que seria removido
title: "reset"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:23Z
---

# `openclaw reset`

Redefine a configuração/estado local (mantém a CLI instalada).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
