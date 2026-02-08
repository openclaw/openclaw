---
summary: "Reference CLI pour `openclaw tui` (interface utilisateur terminale connectee a la Gateway (passerelle))"
read_when:
  - Vous souhaitez une interface utilisateur terminale pour la Gateway (passerelle) (adaptée a l'acces a distance)
  - Vous souhaitez transmettre url/token/session depuis des scripts
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: f0a97d92e08746a9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:03Z
---

# `openclaw tui`

Ouvrez l'interface utilisateur terminale connectee a la Gateway (passerelle).

Liens connexes :

- Guide TUI : [TUI](/tui)

## Exemples

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
