---
summary: "Dokumentacja CLI dla `openclaw skills` (list/info/check) oraz kwalifikowalności Skills"
read_when:
  - Chcesz zobaczyć, które Skills są dostępne i gotowe do uruchomienia
  - Chcesz debugować brakujące binaria/zmienne środowiskowe/konfigurację dla Skills
title: "skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:56Z
---

# `openclaw skills`

Sprawdzaj Skills (dołączone + obszar roboczy + zarządzane nadpisania) i zobacz, co jest kwalifikowalne w porównaniu z brakującymi wymaganiami.

Powiązane:

- System Skills: [Skills](/tools/skills)
- Konfiguracja Skills: [Skills config](/tools/skills-config)
- Instalacje ClawHub: [ClawHub](/tools/clawhub)

## Commands

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
