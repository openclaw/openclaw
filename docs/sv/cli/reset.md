---
summary: "CLI-referens för `openclaw reset` (återställ lokal status/konfig)"
read_when:
  - Du vill rensa lokal status samtidigt som CLI:t förblir installerat
  - Du vill göra en torrkörning av vad som skulle tas bort
title: "återställ"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:44Z
---

# `openclaw reset`

Återställ lokal konfig/status (behåller CLI:t installerat).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
