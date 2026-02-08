---
summary: "Referencja CLI dla `openclaw reset` (resetowanie lokalnego stanu/konfiguracji)"
read_when:
  - Chcesz wyczyścić lokalny stan, zachowując zainstalowane CLI
  - Chcesz wykonać próbę na sucho (dry-run), aby zobaczyć, co zostałoby usunięte
title: "reset"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:56Z
---

# `openclaw reset`

Resetowanie lokalnej konfiguracji/stanu (zachowuje zainstalowane CLI).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
