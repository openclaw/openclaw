---
summary: "Reference CLI pour `openclaw reset` (reinitialise l'etat/la configuration locaux)"
read_when:
  - Vous souhaitez effacer l'etat local tout en conservant le CLI installe
  - Vous souhaitez un dry-run de ce qui serait supprime
title: "reset"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:00Z
---

# `openclaw reset`

Reinitialise la configuration et l'etat locaux (le CLI reste installe).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
