---
summary: "Referencja CLI dla `openclaw setup` (inicjalizacja konfiguracji + obszaru roboczego)"
read_when:
  - Wykonujesz konfigurację przy pierwszym uruchomieniu bez pełnego kreatora onboardingu
  - Chcesz ustawić domyślną ścieżkę obszaru roboczego
title: "Konfiguracja"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:02Z
---

# `openclaw setup`

Zainicjuj `~/.openclaw/openclaw.json` oraz obszar roboczy agenta.

Powiązane:

- Pierwsze kroki: [Pierwsze kroki](/start/getting-started)
- Kreator: [Onboarding](/start/onboarding)

## Przykłady

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

Aby uruchomić kreator za pomocą setup:

```bash
openclaw setup --wizard
```
