---
summary: "CLI-referens för `openclaw reset` (återställ lokal status/konfig)"
read_when:
  - Du vill rensa lokal status samtidigt som CLI:t förblir installerat
  - Du vill göra en torrkörning av vad som skulle tas bort
title: "återställ"
---

# `openclaw reset`

Återställ lokal konfig/status (behåller CLI:t installerat).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
